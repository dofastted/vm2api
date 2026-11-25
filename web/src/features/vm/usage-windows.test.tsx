import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClaudeQuotaObservations, VmUsageWindows } from './usage-windows'

function render(five: number | null, seven: number | null) {
  const vm: Vm = {
    id: 'vm-fixture',
    platform: 'openai',
    family: 'codex',
    has_token: true,
    utilization_5h: five == null ? null : five / 100,
    utilization_7d: seven == null ? null : seven / 100,
    codex_usage: {
      windows: [
        { id: '5h', used_percent: five },
        { id: '7d', used_percent: seven },
      ],
    },
  }
  return renderToStaticMarkup(<VmUsageWindows vm={vm} now={0} />)
}

describe('Claude official quota observations', () => {
  const snapshot = {
    official: {
      updated_at: '2026-11-01T00:00:00Z',
      '5h': {
        utilization: null,
        sampled_at: null,
        reset: null,
        status: null,
        stale: false,
      },
      '7d': {
        utilization: 0,
        sampled_at: null,
        reset: null,
        status: 'allowed',
        stale: false,
      },
    },
    passive: {
      '5h': null,
      '7d': {
        utilization: 0.76,
        sampled_at: '2026-10-31T00:00:00Z',
        reset: null,
        status: 'allowed_warning',
        stale: false,
      },
    },
  }
  function claude(overrides = {}) {
    return renderToStaticMarkup(
      <ClaudeQuotaObservations
        vm={
          {
            id: 'fixture',
            has_token: true,
            platform: 'anthropic',
            utilization_7d: 0.76,
            quota_observations: snapshot,
            ...overrides,
          } as Vm
        }
        now={Date.parse('2026-11-01T00:05:00Z')}
      />
    )
  }
  it('keeps VmUsageWindows clean for rack baseline alignment', () => {
    const html = renderToStaticMarkup(
      <VmUsageWindows
        vm={
          {
            id: 'fixture',
            has_token: true,
            platform: 'anthropic',
            utilization_7d: 0.76,
            quota_observations: snapshot,
          } as Vm
        }
        now={Date.parse('2026-11-01T00:05:00Z')}
      />
    )
    expect(html).toContain('76%')
    expect(html).not.toContain('官方侧存储')
  })
  it('stays hidden when official storage matches displayed utilization and is not stale', () => {
    expect(claude({ utilization_7d: 0 })).toBe('')
  })
  it('shows official zero beside conservative usage, source and distinct timestamps', () => {
    const html = claude()
    expect(html).toContain('官方侧存储：')
    expect(html).toContain('0%')
    expect(html).toContain('76%')
    expect(html).toContain('与当前展示不同')
    expect(html).toContain('2026-11-01T00:00:00Z')
    expect(html).toContain('2026-10-31T00:00:00Z')
    expect(html).toContain('窗口采样时间未知')
  })
  it('does not attribute a reconciled 5% value to the older official query', () => {
    const html = claude({
      quota_observations: {
        ...snapshot,
        official: {
          ...snapshot.official,
          '7d': { ...snapshot.official['7d'], utilization: 0.05 },
        },
      },
    })
    expect(html).toContain('官方侧存储：')
    expect(html).toContain('5%')
    expect(html).toContain('2026-11-01T00:00:00Z')
    expect(html).toContain('重置后可能被响应头校正，并非官方查询原始回执')
    expect(html).toContain('不保证对应单窗口采样')
    expect(html).not.toContain('官方查询记录')
    expect(html).not.toContain('官方记录更新时间')
    expect(html).not.toContain('官方查询：')
  })
  it('does not invent official snapshots for old servers or other platforms', () => {
    expect(claude({ quota_observations: undefined })).not.toContain(
      '官方侧存储'
    )
    expect(claude({ platform: 'openai', family: 'codex' })).not.toContain(
      '官方侧存储'
    )
  })
  it('retains stale official observations with a warning, not a new zero', () => {
    const html = claude({
      quota_observations: {
        ...snapshot,
        official: {
          ...snapshot.official,
          '7d': { ...snapshot.official['7d'], utilization: null, stale: true },
        },
      },
    })
    expect(html).toContain('官方侧存储：')
    expect(html).toContain('陈旧')
    expect(html).toContain('未知')
    expect(html).not.toMatch(/>0%</)
  })
})

describe('Codex quota readings after a quota error', () => {
  it('renders unknown readings as dashes, not fabricated 0% or 100%', () => {
    const html = render(null, null)
    expect(html.match(/>—</g)).toHaveLength(2)
    expect(html).not.toMatch(/>\d+%</)
  })

  it('renders a measured cap without inventing the missing window', () => {
    const html = render(100, null)
    expect(html).toContain('100%')
    expect(html.match(/>—</g)).toHaveLength(1)
  })

  it('renders real refreshed measurements normally', () => {
    const html = render(2, 32)
    expect(html).toContain('2%')
    expect(html).toContain('32%')
    expect(html).not.toContain('>—<')
  })
})
