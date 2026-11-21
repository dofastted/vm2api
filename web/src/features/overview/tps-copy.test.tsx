import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TrafficOps } from './traffic-ops'

describe('overview TPS wording', () => {
  it('names the average and says cache traffic is included', () => {
    const html = renderToStaticMarkup(
      <TrafficOps
        ops={{ tps: { avg: 4.2 }, input_tokens: 10, output_tokens: 20 }}
      />
    )
    expect(html).toContain('平均 TPS')
    expect(html).toContain('TPS 另计缓存读写')
    expect(html).not.toContain('>TPS<')
  })
})
