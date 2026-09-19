import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  buildLocalNode,
  clusterTotals,
  formatNodeMetric,
  parseNodeHost,
  type ClusterNode,
} from '@/features/cluster/model'

function node(
  partial: Partial<ClusterNode> & Pick<ClusterNode, 'id' | 'link'>
): ClusterNode {
  return {
    role: 'remote',
    label: partial.id,
    host: '203.0.113.1',
    latencyMs: null,
    vmCount: 2,
    credCount: 2,
    onlineCredCount: 1,
    spendUsd: 10,
    ...partial,
  }
}

describe('formatNodeMetric', () => {
  it('renders dash for unreachable and missing values, not zero', () => {
    expect(formatNodeMetric(node({ id: 'a', link: 'bad' }), 8, String)).toBe(
      '—'
    )
    expect(formatNodeMetric(node({ id: 'b', link: 'none' }), 0, String)).toBe(
      '—'
    )
    expect(formatNodeMetric(node({ id: 'c', link: 'ok' }), null, String)).toBe(
      '—'
    )
    expect(formatNodeMetric(node({ id: 'd', link: 'ok' }), 8, String)).toBe('8')
  })
})

describe('clusterTotals', () => {
  it('counts dead nodes but excludes them from capacity', () => {
    const totals = clusterTotals([
      node({ id: 'live', link: 'ok', vmCount: 8, spendUsd: 12 }),
      node({ id: 'slow', link: 'caution', vmCount: 4, spendUsd: 5 }),
      node({
        id: 'dead',
        link: 'bad',
        vmCount: null,
        credCount: null,
        onlineCredCount: null,
        spendUsd: null,
      }),
    ])
    expect(totals).toEqual({
      nodes: 3,
      reachable: 2,
      unreachable: 1,
      vms: 12,
      creds: 4,
      online: 2,
      spend: 17,
    })
  })
})

describe('buildLocalNode', () => {
  it('counts credentials vs usable credentials from live vms', () => {
    const vms = [
      { id: 'vm-01', has_token: true },
      { id: 'vm-02', has_token: true, availability: { key: 'revoke' } },
      { id: 'vm-03', has_token: false },
    ] as Vm[]
    const local = buildLocalNode({
      host: '127.0.0.1',
      vms,
      spendUsd: 9.5,
      available: true,
    })
    expect(local.link).toBe('ok')
    expect(local.vmCount).toBe(3)
    expect(local.credCount).toBe(2)
    expect(local.onlineCredCount).toBe(1)
    expect(local.spendUsd).toBe(9.5)
  })

  it('degrades to none and nulls when dashboard is unavailable', () => {
    const local = buildLocalNode({
      host: 'localhost',
      vms: [{ id: 'vm-01', has_token: true } as Vm],
      spendUsd: 4,
      available: false,
    })
    expect(local.link).toBe('none')
    expect(local.vmCount).toBeNull()
    expect(local.spendUsd).toBeNull()
  })
})

describe('parseNodeHost', () => {
  it('accepts host or host:port and rejects credential-shaped input', () => {
    expect(parseNodeHost('203.0.113.12')).toBe('203.0.113.12')
    expect(parseNodeHost('edge.example.net:8443')).toBe('edge.example.net:8443')
    expect(parseNodeHost('https://203.0.113.12')).toBeNull()
    expect(parseNodeHost('user:pass@203.0.113.12')).toBeNull()
    expect(parseNodeHost('203.0.113.12/admin')).toBeNull()
    expect(parseNodeHost('203.0.113.12:99999')).toBeNull()
  })
})
