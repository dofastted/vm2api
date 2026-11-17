import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { ClusterApiNode } from '@/types/panel-cluster'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { completeVmDeletion, nodeGoneOf, vmDeletePath } from './delete-vm'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn() },
}))

let client: QueryClient

beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => client.clear())

it('warns that a deleted H1 binding remains pending and awaits the refreshed subscription', async () => {
  const key = ['crag-host-subscription']
  const before = { available_seats: 0, reclaim_pending_count: 0 }
  const after = { available_seats: 0, reclaim_pending_count: 1 }
  client.setQueryData(key, before)
  let finish: (value: typeof after) => void = () => {}
  const observer = new QueryObserver(client, {
    queryKey: key,
    staleTime: Infinity,
    queryFn: () =>
      new Promise<typeof after>((resolve) => {
        finish = resolve
      }),
  })
  const unsubscribe = observer.subscribe(() => {})
  try {
    let completed = false
    const deletion = completeVmDeletion(
      client,
      { deleted: 'slot-a', reclaim_pending: true },
      '已切换活跃到 slot-b 并删除 slot-a'
    ).then(() => {
      completed = true
    })
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
      '已切换活跃到 slot-b 并删除 slot-a',
      { description: 'CRAG 绑定额度待回收确认；旧订阅需先启用槽位回收。' }
    )
    expect(toast.success).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(client.getQueryData(key)).toEqual(before)
    finish(after)
    await deletion
    expect(client.getQueryData(key)).toEqual(after)
  } finally {
    unsubscribe()
  }
})

it('invalidates VM and subscription counts after a confirmed deletion', async () => {
  const affected = [
    ['panel', 'vms'],
    ['panel', 'dashboard'],
    ['crag-host-subscription'],
  ]
  for (const key of [...affected, ['unrelated']]) client.setQueryData(key, {})
  await completeVmDeletion(client, { deleted: 'slot-a' })
  expect(toast.success).toHaveBeenCalledExactlyOnceWith('已删除')
  expect(toast.warning).not.toHaveBeenCalled()
  for (const key of affected)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  expect(client.getQueryState(['unrelated'])?.isInvalidated).toBe(false)
})

it('warns that a force delete left the node container in place', async () => {
  await completeVmDeletion(client, {
    deleted: 'slot-a',
    remote_teardown: 'skipped',
  })
  expect(toast.warning).toHaveBeenCalledExactlyOnceWith('已删除', {
    description: '节点不可达，节点上的容器没有清理。',
  })
  expect(toast.success).not.toHaveBeenCalled()
})

it('offers force delete only for a slot whose node is missing or offline', () => {
  const node = (
    state: ClusterApiNode['link']['state'],
    direct: 'ok' | 'down' | null = null
  ) =>
    ({
      id: 'node-a',
      link: { state },
      direct_link: direct ? { state: direct } : null,
    }) as ClusterApiNode
  expect(nodeGoneOf({ node_id: null }, [])).toBeNull()
  expect(nodeGoneOf({ node_id: 'node-a' }, undefined)).toBeNull()
  expect(nodeGoneOf({ node_id: 'node-a' }, [])).toBe('missing')
  expect(nodeGoneOf({ node_id: 'node-a' }, [node('ready')])).toBeNull()
  expect(nodeGoneOf({ node_id: 'node-a' }, [node('backoff')])).toBe('offline')
  expect(nodeGoneOf({ node_id: 'node-a' }, [node('error', 'down')])).toBe(
    'offline'
  )
  expect(nodeGoneOf({ node_id: 'node-a' }, [node('backoff', 'ok')])).toBeNull()
  expect(vmDeletePath('slot a')).toBe('/api/panel/vms/slot%20a')
  expect(vmDeletePath('slot-a', true)).toBe('/api/panel/vms/slot-a?force=1')
})
