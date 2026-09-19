import type { ClusterNode } from '@/features/cluster/model'

/**
 * RFC 5737 文档网段，避免被当成现网机器。
 * 四种链路各一行，好在没有后端时把状态表看全。
 */
export const MOCK_REMOTES: ClusterNode[] = [
  {
    id: 'remote-sg-1',
    role: 'remote',
    label: 'sg-1',
    host: '203.0.113.12',
    link: 'ok',
    latencyMs: 28,
    vmCount: 8,
    credCount: 8,
    onlineCredCount: 6,
    spendUsd: 142.18,
    synthetic: true,
  },
  {
    id: 'remote-jp-1',
    role: 'remote',
    label: 'jp-1',
    host: '198.51.100.44',
    link: 'caution',
    latencyMs: 480,
    vmCount: 4,
    credCount: 4,
    onlineCredCount: 3,
    spendUsd: 61.02,
    synthetic: true,
  },
  {
    id: 'remote-us-1',
    role: 'remote',
    label: 'us-1',
    host: '192.0.2.88',
    link: 'bad',
    latencyMs: null,
    vmCount: null,
    credCount: null,
    onlineCredCount: null,
    spendUsd: null,
    synthetic: true,
  },
  {
    id: 'remote-hk-1',
    role: 'remote',
    label: 'hk-1',
    host: '203.0.113.80',
    link: 'none',
    latencyMs: null,
    vmCount: null,
    credCount: null,
    onlineCredCount: null,
    spendUsd: null,
    synthetic: true,
  },
]
