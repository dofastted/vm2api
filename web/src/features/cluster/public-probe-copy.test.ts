import { describe, expect, it } from 'vitest'
import { localDetailSummary } from './connection-rows'

const base = {
  control: { mode: 'process', network_mode: 'host' },
  docker: { ok: true },
}

describe('public probe summary wording', () => {
  it('names the observed node probe and local-only panel separately', () => {
    expect(
      localDetailSummary({ ...base, nat: { inbound: 'open' } } as never)
    ).toContain('观测节点回连成功')
    expect(
      localDetailSummary({ ...base, nat: { inbound: 'closed' } } as never)
    ).toContain('观测节点回连未连通')
    expect(
      localDetailSummary({ ...base, nat: { inbound: 'loopback' } } as never)
    ).toContain('面板仅监听本机')
  })
})
