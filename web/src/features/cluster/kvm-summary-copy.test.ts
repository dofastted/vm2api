import { describe, expect, it } from 'vitest'
import { localDetailSummary } from './connection-rows'

const base = {
  control: { mode: 'process', network_mode: 'host' },
  nat: { inbound: 'open' },
  docker: { ok: true },
}

describe('KVM summary wording', () => {
  it('keeps software emulation distinct from unavailable KVM', () => {
    const software = localDetailSummary({
      ...base,
      kvm: { ok: true, accel: 'tcg' },
    } as never)
    expect(software).toContain('仅支持软件模拟')
    expect(software).not.toContain('KVM 不可用')
    const failed = localDetailSummary({ ...base, kvm: { ok: false } } as never)
    expect(failed).toContain('KVM 不可用')
  })
})
