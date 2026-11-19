import { describe, expect, it } from 'vitest'
import {
  antigravityOAuthAuthenticated,
  antigravityOAuthExpired,
  antigravityOAuthPending,
  antigravityOAuthUrl,
  mergeAntigravityOAuthSession,
  type AntigravityOAuthSession,
} from './antigravity-oauth'

const session: AntigravityOAuthSession = {
  session_id: 'login-1',
  status: 'awaiting_code',
  auth_url:
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=abc&code_challenge=challenge',
  expires_at: '2026-10-21T10:05:00.000Z',
  authenticated: false,
}

describe('Antigravity OAuth session lifecycle', () => {
  it('requires confirmed authentication as well as the authenticated state', () => {
    expect(
      antigravityOAuthAuthenticated({ ...session, authenticated: true })
    ).toBe(false)
    expect(
      antigravityOAuthAuthenticated({ ...session, status: 'authenticated' })
    ).toBe(false)
    expect(
      antigravityOAuthPending({ ...session, status: 'authenticated' })
    ).toBe(true)
    expect(
      antigravityOAuthAuthenticated({
        ...session,
        status: 'authenticated',
        authenticated: true,
      })
    ).toBe(true)
  })

  it('discards responses from a previous slot authorization session', () => {
    const stale = {
      ...session,
      session_id: 'previous-login',
      status: 'authenticated' as const,
      authenticated: true,
    }
    expect(mergeAntigravityOAuthSession(session, stale)).toBe(session)
    expect(mergeAntigravityOAuthSession(null, stale)).toBeNull()
  })

  it('does not regress verification or overwrite terminal states with a late poll', () => {
    const verifying = { ...session, status: 'verifying' as const }
    expect(mergeAntigravityOAuthSession(verifying, session)).toBe(verifying)
    const authenticated = {
      ...session,
      status: 'authenticated' as const,
      authenticated: true,
    }
    expect(mergeAntigravityOAuthSession(verifying, authenticated)).toBe(
      authenticated
    )
    expect(mergeAntigravityOAuthSession(authenticated, session)).toBe(
      authenticated
    )
    expect(antigravityOAuthPending(authenticated)).toBe(false)
    expect(antigravityOAuthPending({ ...session, status: 'cancelled' })).toBe(
      false
    )
    expect(antigravityOAuthPending({ ...session, status: 'failed' })).toBe(
      false
    )
  })

  it('expires pending authorization by its ISO deadline without expiring a confirmed login', () => {
    const deadline = Date.parse(session.expires_at)
    expect(antigravityOAuthExpired(session, deadline - 1)).toBe(false)
    expect(antigravityOAuthExpired(session, deadline)).toBe(true)
    expect(
      antigravityOAuthExpired(
        { ...session, status: 'authenticated', authenticated: true },
        deadline
      )
    ).toBe(false)
    expect(
      antigravityOAuthExpired({ ...session, expires_at: 'invalid' }, deadline)
    ).toBe(false)
  })

  it('only exposes Google authorization URLs with the official callback', () => {
    expect(antigravityOAuthUrl(session)).toBe(session.auth_url)
    for (const auth_url of [
      'javascript:alert(1)',
      'data:text/html,test',
      'http://accounts.google.com/',
      'https://example.com/?redirect_uri=https://antigravity.google/oauth-callback',
      'https://accounts.google.com/?redirect_uri=https://example.com/callback',
      'https://user:pass@accounts.google.com/',
      null,
      '',
    ]) {
      expect(antigravityOAuthUrl({ ...session, auth_url })).toBe('')
    }
  })
})
