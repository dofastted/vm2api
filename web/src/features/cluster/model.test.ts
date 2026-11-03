import type {
  ClusterApiNode,
  ClusterDirectLink,
  ClusterLocalStatus,
  NodeHostStats,
} from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  buildLocalMachine,
  buildMachines,
  buildRemoteMachine,
  clusterSummary,
  GiB,
  gibFloor,
  linkLatencyText,
  machineCapacity,
  memoryBytes,
  NEW_SLOT_QUOTA_BYTES,
  remoteLink,
  remoteLinkTone,
  shortNodeLabel,
  slotBucket,
  slotQuotaBytes,
  slotStatusTone,
  sortSlots,
  tierSummary,
} from '@/features/cluster/model'

const G = GiB
const M = 1024 ** 2

function api(
  partial: Partial<ClusterApiNode> & {
    state?: ClusterApiNode['link']['state']
    ssh?: number | null
    direct?: ClusterApiNode['direct_link']
    stats?: Partial<NodeHostStats> | null
  } = {}
): ClusterApiNode {
  const { state = 'ready', ssh = 4, direct = null, stats, ...rest } = partial
  return {
    id: 'node-1',
    label: '节点 A',
    host: '10.10.0.11',
    port: 22,
    username: 'root',
    auth_type: 'key',
    host_key_alg: 'ssh-ed25519',
    host_key_sha256: 'SHA256:x',
    jump_node_id: null,
    created_at: '',
    updated_at: '',
    link: { state, connected_at: '2026-11-02T01:19:03.068Z' },
    health: {
      latency_ms: ssh,
      docker: { ok: true, error: null },
      containers: { total: 26, running: 26 },
      host:
        stats === null
          ? null
          : {
              cpu_count: 8,
              load1: 7.32,
              load5: 4.99,
              load15: 3.68,
              cpu_pct: 91.5,
              mem_total: 32 * G,
              mem_used: 23 * G,
              mem_pct: 71.9,
              containers_mem: 22 * G,
              disk_total: 295 * G,
              disk_used: 19 * G,
              disk_pct: 6.4,
              ...stats,
            },
      checked_at: '2026-11-02T11:16:05.508Z',
    },
    bridge: null,
    install: null,
    direct_link: direct,
    ...rest,
  }
}

const directOk = (ms: number): ClusterDirectLink => ({
  address: '10.10.0.11',
  port: 7790,
  state: 'ok',
  latency_ms: ms,
  error: null,
  gate_error: null,
  checked_at: '',
})

function vm(partial: Partial<Vm> & Pick<Vm, 'id'>): Vm {
  return {
    name: partial.id,
    has_token: true,
    status: 'running',
    schedule_state: 'on',
    account_tier: 'pro',
    runtime_type: 'kvm',
    machine: { memory: '2g' },
    today_cost: 0,
    ...partial,
  } as Vm
}

describe('remoteLink', () => {
  it('does not flag a far node for one slow-ish round trip', () => {
    const us = api({
      ssh: 327,
      direct: { ...directOk(431), address: '198.51.100.20' },
    })
    expect(remoteLink(us)).toBe('ok')
    expect(remoteLinkTone(us).text).toBe('正常')
    expect(linkLatencyText(us)).toBe('直连 431ms · SSH 327ms')
  })

  it('turns yellow only past 800ms or when the direct link fell back to SSH', () => {
    expect(remoteLink(api({ ssh: 1780 }))).toBe('caution')
    const fell = api({
      direct: {
        ...directOk(0),
        state: 'down',
        latency_ms: null,
        error: 'gate_unreachable',
      },
    })
    expect(remoteLink(fell)).toBe('caution')
    expect(remoteLinkTone(fell).text).toBe('直连断了，走 SSH')
    expect(linkLatencyText(fell)).toBe('直连断开 · SSH 4ms')
  })

  it('maps link states that are not ready', () => {
    expect(remoteLink(api({ state: 'backoff' }))).toBe('bad')
    expect(remoteLinkTone(api({ state: 'backoff' })).text).toBe(
      '连不上，重连中'
    )
    expect(remoteLink(api({ state: 'error' }))).toBe('bad')
    expect(remoteLink(api({ state: 'connecting' }))).toBe('none')
    expect(remoteLinkTone(api({ state: 'connecting' })).text).toBe('连接中')
  })
})

describe('capacity', () => {
  it('parses slot memory and adds the measured qemu overhead, not the 512M ceiling', () => {
    expect(memoryBytes('2g')).toBe(2 * G)
    expect(memoryBytes('512m')).toBe(0.5 * G)
    expect(memoryBytes('')).toBeNull()
    expect(slotQuotaBytes(vm({ id: 'a' }))).toBe(2 * G + 150 * M)
    expect(slotQuotaBytes(vm({ id: 'b', machine: { memory: '4g' } }))).toBe(
      4 * G + 150 * M
    )
    expect(
      slotQuotaBytes(
        vm({ id: 'c', runtime_type: 'docker', machine: { memory: '1g' } })
      )
    ).toBe(G)
  })

  it('counts room by quota, with the system share taken from measured use', () => {
    // Example capacity: 12 Pro × (2G + 150M) on 31.35G, 0.93G outside containers, 22.59G in use.
    // The 512M container ceiling used to make this read 「满 · 剩 0.4G」 while about 8G sat free.
    const full = machineCapacity({
      total: 31.35 * G,
      used: 22.59 * G,
      slotsActual: 21.66 * G,
      quota: 12 * (2 * G + 150 * M),
    })
    expect(full.fit).toBe(2)
    expect(gibFloor(full.free)).toBe('4.6')
    expect(full.used).toBe(22.59 * G)
    const empty = machineCapacity({
      total: 31.35 * G,
      used: 0.88 * G,
      slotsActual: 0.04 * G,
      quota: 0,
    })
    expect(empty.fit).toBe(14)
    expect(Math.floor((empty.free || 0) / NEW_SLOT_QUOTA_BYTES)).toBe(14)
  })

  it('cannot tell the room without the slots reading', () => {
    const c = machineCapacity({
      total: 23.5 * G,
      used: 14 * G,
      slotsActual: null,
      quota: 19 * G,
    })
    expect(c.reserve).toBeNull()
    expect(c.free).toBeNull()
    expect(c.fit).toBeNull()
  })
})

describe('slots', () => {
  it('sorts Max first, then by name with numbers in order', () => {
    const out = sortSlots([
      vm({ id: 'slot906' }),
      vm({ id: 'slot2004', account_tier: 'max' }),
      vm({ id: 'Slot262' }),
      vm({ id: 'slot2001', account_tier: 'max' }),
    ]).map((v) => v.id)
    expect(out).toEqual(['slot2001', 'slot2004', 'Slot262', 'slot906'])
    expect(
      tierSummary([
        vm({ id: 'a', account_tier: 'max' }),
        vm({ id: 'b' }),
        vm({ id: 'c' }),
      ])
    ).toBe('1 Max · 2 Pro')
    expect(tierSummary([])).toBe('空')
  })

  it('buckets slots the way the pool view does', () => {
    expect(slotBucket(vm({ id: 'on' }))).toBe('on')
    const seats = vm({
      id: 'seats',
      schedule_state: 'restricted',
      restriction_scope: 'new_session',
      restriction_text: '席位满',
    })
    expect(slotBucket(seats)).toBe('restricted')
    expect(slotStatusTone(seats).text).toBe('受限 · 席位满')
    expect(
      slotBucket(vm({ id: 'off', schedule_state: 'off', schedulable: false }))
    ).toBe('stopped')
    expect(slotStatusTone(vm({ id: 'ok' })).text).toBe('接单中')
  })
})

describe('machines', () => {
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
      observed_via: null,
      local_ips: ['192.0.2.10', '10.10.0.10'],
      behind_nat: false,
      inbound: 'closed',
    },
    docker: {
      ok: true,
      version: '29.9.2',
      running: 16,
      containers: 17,
      slots: 2,
      slots_mem: 6 * G,
      error: null,
    },
    disk: { disk_total: 197 * G, disk_used: 66 * G, disk_pct: 33.7 },
  } as ClusterLocalStatus
  const host = {
    cpu_count: 6,
    load1: 0.72,
    cpu_pct: 12,
    mem_total: 23.5 * G,
    mem_used: 14 * G,
    mem_pct: 59.6,
  }
  const vms = [
    vm({
      id: 'slot2001',
      account_tier: 'max',
      machine: { memory: '4g' },
      today_cost: 107.24,
    }),
    vm({ id: 'oliva', today_cost: 7.72 }),
    vm({ id: 'Slot2011', node_id: 'node-1', today_cost: 37.21 }),
  ]

  it('builds the control host on the same scale as nodes', () => {
    const local = buildLocalMachine({
      hostname: 'panel.example.test',
      vms,
      host,
      status,
      available: true,
    })
    expect(local.name).toBe('本机 VPS')
    expect(local.address).toBe('192.0.2.10')
    expect(local.slots.map((v) => v.id)).toEqual(['slot2001', 'oliva'])
    expect(local.todayUsd).toBeCloseTo(114.96)
    expect(local.disk?.pct).toBe(33.7)
    // 23.5 − (14 − 6) − (4G + 150M + 2G + 150M) ≈ 9.2G → 4 台（每台约 2.15G）
    expect(local.capacity?.reserve).toBe(8 * G)
    expect(local.capacity?.fit).toBe(4)
  })

  it('shows dashes, not zeros, for a node it cannot reach', () => {
    const dead = buildRemoteMachine(api({ state: 'backoff' }), vms)
    expect(dead.link).toBe('bad')
    expect(dead.cpu).toBeNull()
    expect(dead.capacity).toBeNull()
    expect(dead.slots).toHaveLength(1)
  })

  it('names nodes without the trailing IP and keeps the control host first', () => {
    expect(shortNodeLabel('远端节点 198.51.100.20')).toBe('远端节点')
    const ms = buildMachines({
      hostname: 'x',
      vms,
      nodes: [
        api({
          id: 'node-us',
          label: '远端节点 198.51.100.20',
          host: '198.51.100.20',
        }),
        api(),
      ],
      host,
      status,
      available: true,
    })
    expect(ms.map((m) => m.name)).toEqual(['本机 VPS', '节点 A', '远端节点'])
    const sum = clusterSummary(ms)
    expect(sum).toMatchObject({
      machines: 3,
      online: 3,
      offline: 0,
      slots: 3,
      on: 3,
      restricted: 0,
      stopped: 0,
    })
  })

  it('marks the control host unknown when the dashboard failed', () => {
    const local = buildLocalMachine({
      hostname: 'h',
      vms,
      host: undefined,
      status: undefined,
      available: false,
    })
    expect(local.link).toBe('none')
    expect(local.tone.text).toBe('读不到')
    expect(local.capacity).toBeNull()
  })
})
