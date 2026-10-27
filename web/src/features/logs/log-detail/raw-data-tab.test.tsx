import type { RequestLogItem } from '@/types/panel-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RawDataTab } from './raw-data-tab'

const fixture = vi.hoisted(() => ({ item: {} as RequestLogItem }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { item: fixture.item }, isLoading: false }),
}))
vi.mock('../queries', () => ({ requestLogQueryOptions: () => ({}) }))

function render(item: RequestLogItem) {
  fixture.item = item
  return renderToStaticMarkup(<RawDataTab requestId='test' logMode='debug' />)
}

describe('outbound request header provenance', () => {
  it('identifies CLI final headers and keeps the envelope separate', () => {
    const html = render({
      outbound_headers_source: 'cli_final',
      outbound_headers: { 'content-length': '1234' },
      worker_envelope_headers: { 'x-app': 'cli' },
    })
    expect(html).toContain('最终出站请求头')
    expect(html).toContain('1234')
    expect(html).toContain('槽位入站请求头（中间值）')
    expect(html).toContain('凭证已脱敏')
  })

  it('shows unavailable rather than presenting the envelope as final', () => {
    const html = render({
      outbound_headers_source: 'unavailable',
      outbound_headers: null,
      worker_envelope_headers: { 'x-app': 'cli' },
    })
    expect(html).toContain('未获取到最终出站请求头')
    expect(html).toContain('槽位入站请求头（中间值）')
  })

  it('does not retroactively relabel historical values as final', () => {
    const html = render({ outbound_headers: { 'x-app': 'cli' } })
    expect(html).toContain('历史记录未标注采集位置')
    expect(html).not.toContain('>最终出站请求头<')
  })
})
