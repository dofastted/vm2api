import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type {
  PoolProxySnapshot,
  PoolQueueSummary,
  PoolSeatSnapshot,
  Vm,
  VmDetailPayload,
} from '@/types/panel-vm'
import { panelFetch } from '@/lib/api'
import { hasSession } from '@/lib/session'
import { vmsListQueryOptions } from '@/features/vm/queries'

const RETRY_MS = 5000

type SseFrame = { event: string; data: string }

/** 解析 `text/event-stream` 缓冲区；返回完整帧与未结束的尾部。 */
export function parseSseFrames(buffer: string): {
  frames: SseFrame[]
  rest: string
} {
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n')
  const rest = blocks.pop() ?? ''
  const frames: SseFrame[] = []
  for (const block of blocks) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length) frames.push({ event, data: data.join('\n') })
  }
  return { frames, rest }
}

const SEAT_FIELDS = [
  'seats_used',
  'seats_max',
  'seats_grace',
  'queue_depth',
  'conc_waiting',
  'inflight',
] as const

function sameSessions(a: Vm['seat_sessions'], b: Vm['seat_sessions']) {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  return left.every((seat, i) => {
    const other = right[i]
    return (
      seat.index === other?.index &&
      seat.session_id === other?.session_id &&
      seat.state === other?.state &&
      seat.inflight === other?.inflight &&
      (seat.held_until ?? null) === (other?.held_until ?? null)
    )
  })
}

/** 席位快照只覆盖 Claude 行（`seats_max` 非空）的实时字段；缺席即空闲。 */
export function mergeSeatVm(vm: Vm, snap: PoolSeatSnapshot): Vm {
  if (vm.seats_max == null) return vm
  const live = snap.seats[vm.id]
  // 缺席的 VM 只清零计数；上限不在帧里，保留列表接口给的值。
  const next = {
    seats_used: live?.seats_used ?? 0,
    seats_max: live?.seats_max ?? vm.seats_max,
    seats_grace: live?.seats_grace ?? 0,
    seat_sessions: live?.sessions ?? [],
    queue_depth: live?.queue_depth ?? 0,
    conc_waiting: live?.conc_waiting ?? 0,
    inflight: live?.inflight ?? 0,
  }
  if (
    SEAT_FIELDS.every((key) => vm[key] === next[key]) &&
    sameSessions(vm.seat_sessions, next.seat_sessions)
  ) {
    return vm
  }
  return { ...vm, ...next }
}

export function mergeSeatSnapshot(items: Vm[], snap: PoolSeatSnapshot): Vm[] {
  return items.map((vm) => mergeSeatVm(vm, snap))
}

const PROXY_FIELDS = [
  'status',
  'enabled',
  'blocked_reason',
  'latency_ms',
  'last_error',
  'last_probe_at',
] as const

/** 代理帧只改同一个代理的健康字段；换绑（id 不同）等列表轮询带回新的 `proxy`。 */
export function mergeProxyVm(vm: Vm, snap: PoolProxySnapshot): Vm {
  const live = snap.proxies[vm.id]
  const current = vm.proxy
  if (!live || !current || current.id !== live.id) return vm
  const next = {
    status: live.status,
    enabled: live.enabled,
    blocked_reason: live.blocked_reason ?? null,
    latency_ms: live.latency_ms,
    last_error: live.last_error,
    last_probe_at: live.last_probe_at,
  }
  if (PROXY_FIELDS.every((key) => current[key] === next[key])) return vm
  return { ...vm, proxy: { ...current, ...next } }
}

/** 全局排队不挂在任何 VM 上，单独写进列表缓存的 `pool_queue`。 */
export function mergePoolQueue(
  prev: PoolQueueSummary | undefined,
  snap: PoolSeatSnapshot
): PoolQueueSummary {
  if (
    prev?.global_queue_depth === snap.global_queue_depth &&
    prev.queue_max === snap.queue_max
  ) {
    return prev
  }
  return {
    global_queue_depth: snap.global_queue_depth,
    queue_max: snap.queue_max,
  }
}

type VmList = { items: Vm[]; pool_queue?: PoolQueueSummary }
type Dashboard = { vms?: Vm[] }

/**
 * 订阅 `/api/panel/pool/stream`，把席位/在飞/排队与代理健康写进 VM 列表、
 * 总览和详情缓存。EventSource 不能带 Bearer，所以用 fetch 读流；断线期间
 * 各页照常靠轮询刷新。
 */
export function usePoolSeatStream() {
  const qc = useQueryClient()
  useEffect(() => {
    const listKey = vmsListQueryOptions().queryKey
    const ctrl = new AbortController()
    let retry: number | undefined

    const patchVms = (patch: (vm: Vm) => Vm, queue?: PoolSeatSnapshot) => {
      qc.setQueryData<VmList>(listKey, (prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map(patch),
              ...(queue
                ? { pool_queue: mergePoolQueue(prev.pool_queue, queue) }
                : {}),
            }
          : prev
      )
      qc.setQueriesData<Dashboard>(
        { queryKey: ['panel', 'dashboard'] },
        (prev) => (prev?.vms ? { ...prev, vms: prev.vms.map(patch) } : prev)
      )
      // 详情页 `['panel','vm',id]`；子查询（seed / credential …）键更长，跳过。
      qc.setQueriesData<VmDetailPayload>(
        {
          queryKey: ['panel', 'vm'],
          predicate: (query) => query.queryKey.length === 3,
        },
        (prev) => {
          const vm = prev?.vm as Vm | undefined
          if (!prev || !vm?.id) return prev
          const next = patch(vm)
          if (next === vm) return prev
          return {
            ...prev,
            vm: next,
            ...(prev.proxy && next.proxy !== vm.proxy
              ? { proxy: { ...prev.proxy, ...next.proxy } }
              : {}),
          }
        }
      )
    }

    const connect = async () => {
      if (!hasSession()) return
      let fatal = false
      try {
        const res = await panelFetch('/api/panel/pool/stream', {
          signal: ctrl.signal,
          headers: { Accept: 'text/event-stream' },
        })
        // 鉴权失败不重连：等下次挂载（重新登录后）再订阅。
        if (res.status === 401 || res.status === 403) fatal = true
        if (!res.ok || !res.body) return
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const parsed = parseSseFrames(buffer + value)
          buffer = parsed.rest
          for (const frame of parsed.frames) {
            try {
              if (frame.event === 'seats') {
                const snap = JSON.parse(frame.data) as PoolSeatSnapshot
                patchVms((vm) => mergeSeatVm(vm, snap), snap)
              } else if (frame.event === 'proxy') {
                const snap = JSON.parse(frame.data) as PoolProxySnapshot
                patchVms((vm) => mergeProxyVm(vm, snap))
              }
            } catch {
              // 单帧损坏只丢这一帧，下一次变化会再推完整快照。
            }
          }
        }
      } catch {
        // 网络中断或 abort：abort 由 finally 判定，不重连。
      } finally {
        if (!ctrl.signal.aborted && !fatal) {
          retry = window.setTimeout(() => void connect(), RETRY_MS)
        }
      }
    }

    void connect()
    return () => {
      ctrl.abort()
      clearTimeout(retry)
    }
  }, [qc])
}
