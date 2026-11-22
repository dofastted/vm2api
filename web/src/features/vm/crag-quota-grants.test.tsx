import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CragQuotaGrants } from './crag-quota-grants'
import type { CragHostStatus } from './queries'

const DAY = 86_400
const base = Math.floor(Date.parse('2027-03-01T00:00:00Z') / 1000)

const render = (quota_grants?: CragHostStatus['quota_grants']) =>
  renderToStaticMarkup(
    <CragQuotaGrants
      status={{ ready: true, state: 'active', quota_grants } as CragHostStatus}
    />
  )

describe('CragQuotaGrants', () => {
  it('stays out of the way when there is nothing the summary has not already said', () => {
    // No detail at all, and the lapsed case where the Authority withholds it.
    expect(render(undefined)).toBe('')
    // One window: its seats and its expiry are exactly what the summary shows,
    // so listing it again would only add a number without adding information.
    expect(render([{ expires_at: base, slot_limit: 2 }])).toBe('')
  })

  it('lists every window and marks the one the summary expiry refers to', () => {
    const html = render([
      { code_id: 'abcdef0123456789', expires_at: base, slot_limit: 1 },
      {
        code_id: 'fedcba9876543210',
        expires_at: base + 30 * DAY,
        slot_limit: 2,
      },
    ])
    expect(html).toContain('共 2 段额度')
    // Voucher identity is truncated: the full code id is not needed to tell two
    // windows apart, and the panel is not a place to copy it from.
    expect(html).toContain('abcdef01')
    expect(html).not.toContain('abcdef0123456789')
    expect(html).toContain('fedcba98')
    // Only the soonest is marked -- that is the one the summary counts down to,
    // and the point of saying so is that the others do not expire with it.
    expect(html.match(/· 最早/g)).toHaveLength(1)
  })

  it('names the baseline window that has no voucher behind it', () => {
    // An H1 host's first redemption becomes an unlabelled baseline, so a row
    // with no code_id is normal rather than missing data.
    const html = render([
      { expires_at: base, slot_limit: 3 },
      { code_id: 'abcdef0123456789', expires_at: base + DAY, slot_limit: 1 },
    ])
    expect(html).toContain('初始额度')
  })

  it('shows an unlimited window as unlimited rather than as a missing number', () => {
    const html = render([
      { expires_at: base },
      { code_id: 'abcdef0123456789', expires_at: base + DAY, slot_limit: 1 },
    ])
    expect(html).toContain('不限')
    expect(html).not.toContain('待核对')
  })
})
