import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TrafficOps } from './traffic-ops'

describe('overview SLA empty wording', () => {
  it('does not present a default perfect SLA when there are no requests', () => {
    const html = renderToStaticMarkup(
      <TrafficOps
        ops={{ requests: 0, success: 0, errors: 0, sla: 1, error_rate: 0 }}
      />
    )
    expect(html).toContain('所选时段无请求')
    expect(html).not.toContain('100.0%')
    expect(html).not.toContain('0.0%')
  })

  it('does not claim an unknown window has no requests', () => {
    const html = renderToStaticMarkup(<TrafficOps ops={undefined} />)
    expect(html).not.toContain('所选时段无请求')
  })

  it('keeps the measured rates when every request succeeded', () => {
    const html = renderToStaticMarkup(
      <TrafficOps
        ops={{ requests: 2, success: 2, errors: 0, sla: 1, error_rate: 0 }}
      />
    )
    expect(html).toContain('100.0%')
    expect(html).toContain('0.0%')
    expect(html).not.toContain('所选时段无请求')
  })
})
