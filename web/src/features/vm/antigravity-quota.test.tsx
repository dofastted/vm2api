import type { AntigravityQuotaBucket, Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { antigravityWindowLabel } from './antigravity-quota'
import { VmUsageWindows } from './usage-windows'

const bucket = (
  patch: Partial<AntigravityQuotaBucket>
): AntigravityQuotaBucket => ({
  id: null,
  name: null,
  description: null,
  window: null,
  remaining: null,
  remaining_amount: null,
  disabled: false,
  reset_at: null,
  ...patch,
})

describe('Antigravity quota windows', () => {
  it('maps official windows and bucket ids onto the 5H / 7D labels', () => {
    expect(antigravityWindowLabel(bucket({ window: '5h' }))).toBe('5H')
    expect(antigravityWindowLabel(bucket({ id: 'gemini-weekly' }))).toBe('7D')
    expect(antigravityWindowLabel(bucket({ window: '7d' }))).toBe('7D')
    expect(
      antigravityWindowLabel(bucket({ id: 'gemini-4-argon-weekly' }))
    ).toBe('7D')
  })

  it('shows remaining balance per group instead of the Claude used share', () => {
    const vm: Vm = {
      id: 'vm-ag',
      platform: 'antigravity',
      family: 'antigravity',
      antigravity: { authenticated: true },
      antigravity_quota: {
        updated_at: '2026-10-22T00:00:00Z',
        description: null,
        error: null,
        groups: [
          {
            name: 'Gemini 4 Argon',
            description: null,
            buckets: [bucket({ id: 'argon-weekly', remaining: 0.88 })],
          },
        ],
      },
    }
    const html = renderToStaticMarkup(<VmUsageWindows vm={vm} now={0} />)
    expect(html).toContain('Gemini 4 Argon')
    expect(html).toContain('剩88%')
    expect(html).not.toContain('尚未查询额度')
  })

  it('keeps a failed refresh visible and never invents a balance', () => {
    const vm: Vm = {
      id: 'vm-ag',
      platform: 'antigravity',
      family: 'antigravity',
      antigravity: { authenticated: true },
      antigravity_quota: {
        updated_at: null,
        description: null,
        groups: [],
        error: { code: 'x', message: '槽位未运行', at: '2026-10-22T00:00:00Z' },
      },
    }
    const html = renderToStaticMarkup(<VmUsageWindows vm={vm} now={0} />)
    expect(html).toContain('尚未查询额度')
    expect(html).toContain('槽位未运行')
    expect(html).not.toMatch(/剩\d/)
  })
})
