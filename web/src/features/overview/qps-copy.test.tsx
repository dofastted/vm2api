import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TrafficOps } from './traffic-ops'

describe('overview QPS wording', () => {
  it('names the window average and minute-bucket rates', () => {
    const html = renderToStaticMarkup(
      <TrafficOps
        ops={{
          qps: { avg: 1.2, current: 0.5, peak: 3 },
        }}
      />
    )
    expect(html).toContain('平均 QPS')
    expect(html).toContain('最近有请求的分钟')
    expect(html).toContain('分钟峰值')
    expect(html).not.toContain('>QPS<')
    expect(html).not.toContain('当前 ')
  })
})
