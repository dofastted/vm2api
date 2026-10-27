import type { PoolProxySnapshot, PoolSeatSnapshot, Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  mergePoolQueue,
  mergeProxyVm,
  mergeSeatSnapshot,
  parseSseFrames,
} from './use-pool-seat-stream'

describe('seat stream frames', () => {
  it('keeps a frame split across chunks until its blank line arrives', () => {
    const first = parseSseFrames('event: seats\ndata: {"seats":')
    expect(first.frames).toEqual([])
    const second = parseSseFrames(`${first.rest}{},"ts":1}\n\n: ping\n\n`)
    expect(second.frames).toEqual([
      { event: 'seats', data: '{"seats":{},"ts":1}' },
    ])
    expect(second.rest).toBe('')
  })

  it('treats CRLF line endings like LF', () => {
    const { frames } = parseSseFrames('event: seats\r\ndata: {}\r\n\r\n')
    expect(frames).toEqual([{ event: 'seats', data: '{}' }])
  })
})

describe('seat snapshot merge', () => {
  const claude = {
    id: 'vm-1',
    seats_max: 2,
    seats_used: 2,
    seats_grace: 1,
    queue_depth: 3,
    conc_waiting: 2,
    inflight: 1,
  } as Vm
  const codex = { id: 'vm-2', seats_max: null, seats_used: null } as Vm
  const snap = (seats: PoolSeatSnapshot['seats']): PoolSeatSnapshot => ({
    seats,
    global_queue_depth: 0,
    queue_max: 50,
    ts: 1,
  })

  it('zeroes Claude rows absent from the snapshot and leaves Codex rows alone', () => {
    const [nextClaude, nextCodex] = mergeSeatSnapshot([claude, codex], snap({}))
    expect(nextClaude).toMatchObject({
      seats_used: 0,
      seats_max: 2,
      seats_grace: 0,
      seat_sessions: [],
      queue_depth: 0,
      conc_waiting: 0,
      inflight: 0,
    })
    expect(nextCodex).toBe(codex)
  })

  it('applies live seat, grace, queue counts and the sessions holding those slots', () => {
    const live = {
      seats_used: 1,
      seats_max: 4,
      seats_grace: 1,
      queue_depth: 2,
      conc_waiting: 1,
      inflight: 0,
      sessions: [
        {
          index: 0,
          session_id: '01a17519-60b0-7218-9d67-d31c47ceedbc',
          state: 'held',
          inflight: 0,
          held_until: 9,
        },
      ],
    }
    const [next] = mergeSeatSnapshot([claude], snap({ 'vm-1': live }))
    const { sessions, ...counts } = live
    expect(next).toMatchObject({ ...counts, seat_sessions: sessions })
  })

  it('keeps the row identity when nothing changed', () => {
    const seated = {
      ...claude,
      seat_sessions: [
        {
          index: 0,
          session_id: 'sess-a',
          state: 'active',
          inflight: 1,
          held_until: null,
        },
      ],
    } as Vm
    const live = {
      seats_used: 2,
      seats_max: 2,
      seats_grace: 1,
      queue_depth: 3,
      conc_waiting: 2,
      inflight: 1,
      sessions: seated.seat_sessions ?? undefined,
    }
    const [next] = mergeSeatSnapshot([seated], snap({ 'vm-1': live }))
    expect(next).toBe(seated)
  })
})

describe('proxy health merge', () => {
  const vm = {
    id: 'vm-1',
    proxy: { id: 'px-1', host: '1.2.3.4', status: 'ok', latency_ms: 80 },
  } as Vm
  const frame = (proxies: PoolProxySnapshot['proxies']): PoolProxySnapshot => ({
    proxies,
    ts: 1,
  })

  it('applies live health for the same bound proxy', () => {
    const next = mergeProxyVm(
      vm,
      frame({
        'vm-1': {
          id: 'px-1',
          status: 'dead',
          enabled: false,
          latency_ms: 80,
          last_error: 'timeout',
        },
      })
    )
    expect(next.proxy).toMatchObject({
      id: 'px-1',
      host: '1.2.3.4',
      status: 'dead',
      last_error: 'timeout',
    })
  })

  it('ignores a frame for a different proxy or a missing VM', () => {
    expect(
      mergeProxyVm(vm, frame({ 'vm-1': { id: 'px-2', status: 'dead' } }))
    ).toBe(vm)
    expect(mergeProxyVm(vm, frame({}))).toBe(vm)
  })
})

describe('global queue merge', () => {
  const frame = (depth: number, max: number): PoolSeatSnapshot => ({
    seats: {},
    global_queue_depth: depth,
    queue_max: max,
    ts: 1,
  })

  it('writes the global queue depth and cap from the frame', () => {
    expect(mergePoolQueue(undefined, frame(4, 50))).toEqual({
      global_queue_depth: 4,
      queue_max: 50,
    })
  })

  it('keeps the previous object when unchanged', () => {
    const prev = { global_queue_depth: 4, queue_max: 50 }
    expect(mergePoolQueue(prev, frame(4, 50))).toBe(prev)
    expect(mergePoolQueue(prev, frame(0, 50))).toEqual({
      global_queue_depth: 0,
      queue_max: 50,
    })
  })
})
