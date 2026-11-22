import { describe, expect, it } from 'vitest'
import { isGeminiHostIssue } from './gemini-recovery'

describe('Gemini maintenance recovery classification', () => {
  it('offers maintenance for host, payload and native runtime failures', () => {
    expect(isGeminiHostIssue('gemini_host_socket_missing')).toBe(true)
    expect(isGeminiHostIssue('gemini_payload_invalid')).toBe(true)
    expect(isGeminiHostIssue('gemini_egress_unavailable')).toBe(true)
    expect(isGeminiHostIssue('gemini_native_worker_unavailable')).toBe(true)
  })

  it('separates unsupported installed OAuth capability from account authorization', () => {
    expect(isGeminiHostIssue('gemini_test_oauth_unsupported')).toBe(true)
    expect(isGeminiHostIssue('gemini_oauth_required')).toBe(false)
    expect(isGeminiHostIssue('gemini_terminal_requires_oauth')).toBe(false)
  })

  it('does not suggest installation for external account, eligibility or proxy failures', () => {
    expect(isGeminiHostIssue('gemini_location_unsupported')).toBe(false)
    expect(isGeminiHostIssue('gemini_quota_exhausted')).toBe(false)
    expect(isGeminiHostIssue('gemini_proxy_unavailable')).toBe(false)
    expect(isGeminiHostIssue('gemini_api_key_rejected')).toBe(false)
    expect(isGeminiHostIssue('gemini_release_redemption_required')).toBe(false)
    expect(isGeminiHostIssue('gemini_release_code_invalid')).toBe(false)
  })

  it('requires an exact known diagnostic code, not a message or arbitrary value', () => {
    expect(isGeminiHostIssue(undefined)).toBe(false)
    expect(isGeminiHostIssue({ code: 'gemini_payload_invalid' })).toBe(false)
    expect(isGeminiHostIssue('upstream said gemini_payload_invalid')).toBe(
      false
    )
    expect(isGeminiHostIssue('constructor')).toBe(false)
    expect(isGeminiHostIssue('gemini_operation_busy')).toBe(false)
  })
})
