import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HealthPane } from './health-pane'

describe('signature repair wording', () => {
  it('does not promise a final 200 after one retry', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthPane
          title='探测'
          failover={{}}
          healthProbe={{}}
          compatibility={{ min_max_tokens: {} }}
          onFailoverChange={() => {}}
          onHealthProbeChange={() => {}}
          onCompatibilityChange={() => {}}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('清理思考历史后重试一次；最终结果取决于重试')
    expect(html).not.toContain('客户端最终看到')
  })
})
