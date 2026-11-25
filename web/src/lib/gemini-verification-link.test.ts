import { describe, expect, it } from 'vitest'
import { geminiEligibilityNotice } from './gemini-account-status'

const validation_url =
  'https://accounts.google.com/example-verification?fixture=synthetic'

describe('paid-tier verification link is an action, not an eligibility verdict', () => {
  it('keeps the official action available without claiming the account is blocked', () => {
    const notice = geminiEligibilityNotice({ validation_url })
    expect(notice?.validationUrl).toBe(validation_url)
    expect(notice?.label).toContain('不代表当前账号不可用')
  })

  it('does not resurrect a stale action after a newer successful inference', () => {
    expect(
      geminiEligibilityNotice(
        { validation_url, checked_at: '2026-11-25T01:00:00Z' },
        {
          state: 'completed',
          finished_at: '2026-11-25T02:00:00Z',
        }
      )
    ).toBeNull()
    expect(
      geminiEligibilityNotice(
        { validation_url, checked_at: '2026-11-25T02:00:00Z' },
        {
          state: 'completed',
          finished_at: '2026-11-25T01:00:00Z',
        }
      )?.validationUrl
    ).toBe(validation_url)
    expect(
      geminiEligibilityNotice(
        { validation_url },
        {
          state: 'failed',
          finished_at: '2026-11-25T02:00:00Z',
        }
      )?.validationUrl
    ).toBe(validation_url)
  })

  it('does not display unsafe or missing URLs', () => {
    for (const url of [
      null,
      '',
      'http://accounts.google.com/check',
      'https://accounts.google.com.evil.test/check',
      'https://user@accounts.google.com/check',
      'https://accounts.google.com/check#fragment',
      'javascript:alert(1)',
    ]) {
      expect(geminiEligibilityNotice({ validation_url: url })).toBeNull()
    }
  })

  it('preserves blocking notices independently of link availability', () => {
    expect(
      geminiEligibilityNotice({ eligibility: 'verification_required' })?.label
    ).toContain('VALIDATION_REQUIRED')
    expect(
      geminiEligibilityNotice({
        eligibility: 'location_unsupported',
        validation_url,
      })?.validationUrl
    ).toBeNull()
  })
})
