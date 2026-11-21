import { Clock } from 'lucide-react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatDuration } from '@/lib/usage-format'
import { BentoMetricCard } from './metric-card'

function renderDuration(value: number | null) {
  return renderToStaticMarkup(
    <BentoMetricCard
      title='平均耗时'
      value={value}
      formatter={(current) => formatDuration(Math.round(current))}
      icon={Clock}
    />
  )
}

describe('missing duration metric', () => {
  it('shows a dash when no duration sample exists', () => {
    const html = renderDuration(null)
    expect(html).toContain('>—</h3>')
    expect(html).not.toContain('0 ms')
  })

  it('keeps a measured zero distinct from a missing sample', () => {
    const html = renderDuration(0)
    expect(html).toContain('>0ms<')
    expect(html).not.toContain('>—</h3>')
  })
})
