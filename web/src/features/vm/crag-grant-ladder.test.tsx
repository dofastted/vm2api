import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CragGrantLadder } from './crag-runtime-counts'
import type { CragHostStatus } from './queries'

const DAY = 86_400
const now = Math.floor(Date.now() / 1000)
const active = (grants?: CragHostStatus['grants']): CragHostStatus => ({
  ready: true,
  state: 'active',
  grants,
})

describe('CragGrantLadder', () => {
  it('renders nothing when there is no ladder to show', () => {
    expect(renderToStaticMarkup(<CragGrantLadder />)).toBe('')
    expect(renderToStaticMarkup(<CragGrantLadder status={active()} />)).toBe('')
    expect(renderToStaticMarkup(<CragGrantLadder status={active([])} />)).toBe(
      ''
    )
  })

  it('lists every voucher with its own seats and expiry', () => {
    const html = renderToStaticMarkup(
      <CragGrantLadder
        status={active([
          { slots: 2, expires_at: now + DAY },
          { slots: 5, expires_at: now + 30 * DAY },
        ])}
      />
    )
    // Both vouchers stay visible, so a stacked subscription explains its own
    // total instead of showing a single opaque number.
    expect(html).toContain('兑换码槽位 2')
    expect(html).toContain('兑换码槽位 5')
    expect(html.match(/有效至/g)).toHaveLength(2)
    expect(html).not.toContain('已于')
  })

  it('keeps a lapsed voucher visible but marks it expired', () => {
    const html = renderToStaticMarkup(
      <CragGrantLadder
        status={active([
          { slots: 2, expires_at: now - DAY },
          { slots: 'unlimited', expires_at: now + DAY },
        ])}
      />
    )
    expect(html).toContain('已于')
    expect(html).toContain('有效至')
    expect(html).toContain('不限')
  })
})
