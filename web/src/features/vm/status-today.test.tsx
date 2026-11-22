import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VmStatusBoard } from './detail-status-board'

const vm = {
  id: 'vm-01',
  today_cost: 1.25,
  today_requests: 4,
} as Vm

describe('status board today cost wording', () => {
  it('names Shanghai-calendar spend as Beijing time', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <VmStatusBoard
          vm={vm}
          acc={{ today_cost: 1.25 }}
          proxy={{}}
          dash={{ data: undefined }}
          u5={0}
          u7={0}
          now={0}
          cost={{ today: 0, w: 0, tok: 0, total: 0, req: 0 }}
          split={null}
          conc={{
            max: 1,
            inf: 0,
            fmax: 0,
            fin: 0,
            cooling: false,
            hot: false,
            title: '',
          }}
          rpm={null}
          today={{ requests: 4, input: 0, output: 0 }}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('今日 · 北京时间')
    expect(html).toContain('$1.25')
    expect(html).not.toContain('>今日<')
  })
})
