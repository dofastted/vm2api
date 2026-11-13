import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { poolQuota } from './pool-quota'

function vm(over: Partial<Vm> = {}): Vm {
  return {
    id: 'vm-01',
    has_token: true,
    has_refresh: true,
    availability: { key: 'ok', usable: true, text: '可用' },
    ...over,
  }
}

describe('Fable pool windows', () => {
  it('includes the measured Pro window in aggregate usage', () => {
    const window = poolQuota([
      vm({ subscription_type: 'pro', utilization_7d_oi: 0.25 }),
    ]).windows[2]
    expect(window.capacity).toBe(1)
    expect(window.usedAccounts).toBe(0.25)
    expect(window.remainPct).toBe(75)
  })

  it('does not invent Pro capacity when no window has been returned', () => {
    expect(
      poolQuota([vm({ subscription_type: 'pro' })]).windows[2].capacity
    ).toBe(0)
    const zero = poolQuota([
      vm({ subscription_type: 'pro', utilization_7d_oi: 0 }),
    ]).windows[2]
    expect(zero.capacity).toBe(1)
    expect(zero.segs[0].probed).toBe(true)
  })

  it('retains the unprobed Max plan window and excludes other platforms', () => {
    const max = poolQuota([vm({ subscription_type: 'max' })]).windows[2]
    expect(max.capacity).toBe(1)
    expect(max.segs[0].probed).toBe(false)
    const codex = vm({ platform: 'openai', utilization_7d_oi: 0.4 })
    expect(poolQuota([codex]).windows[2].capacity).toBe(0)
  })

  it('does not treat a successful model probe as a zero usage reading', () => {
    const window = poolQuota([
      vm({ subscription_type: 'pro', fable: { ok: true } }),
    ]).windows[2]
    expect(window.capacity).toBe(1)
    expect(window.segs[0].probed).toBe(false)
  })
})
