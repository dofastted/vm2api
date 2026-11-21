import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HealthAxis } from './vm-row-detail'

describe('request health axis marks', () => {
  it('places seven-day marks by elapsed fractions of the rolling window', () => {
    const html = renderToStaticMarkup(<HealthAxis range='7d' />)
    expect(html).toContain('left:0%')
    expect(html).toContain('>7 天前<')
    expect(html).toContain('left:28.57142857142857%')
    expect(html).toContain('>5d<')
    expect(html).toContain('left:57.14285714285714%')
    expect(html).toContain('>3d<')
    expect(html).toContain('left:85.71428571428571%')
    expect(html).toContain('>1d<')
    expect(html).toContain('left:100%')
    expect(html).toContain('>现在<')
  })
})
