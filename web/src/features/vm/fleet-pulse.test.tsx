import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FleetPulse } from './fleet-pulse'

describe('fleet today cost wording', () => {
  it('names the Shanghai-calendar spend as Beijing time', () => {
    const html = renderToStaticMarkup(
      <FleetPulse
        vms={[{ id: 'vm-01', today_cost: 1.25, window_7d_cost: 4.5 } as Vm]}
        filter='all'
        onFilter={() => undefined}
      />
    )

    expect(html).toContain('今日消耗 · 北京时间')
    expect(html).toContain('$1.25')
    expect(html).not.toContain('>今日消耗<')
    expect(html).toContain('7 天窗口余量')
    expect(html).toContain('7 天窗口 $4.50')
    expect(html).toContain('7 天窗口成败')
    expect(html).not.toContain('7d 余量分布')
    expect(html).not.toContain('7D 成败')
  })
})
