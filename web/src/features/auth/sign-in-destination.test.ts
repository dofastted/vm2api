import { describe, expect, it, vi } from 'vitest'
import { resolveSignInDestination, usableRedirect } from './sign-in-destination'

describe('usableRedirect', () => {
  it('accepts a router href with a query string', () => {
    expect(usableRedirect('/keys')).toBe('/keys')
    expect(usableRedirect('/vm/x?tab=y')).toBe('/vm/x?tab=y')
  })

  it('refuses anything that is not an in-app path', () => {
    expect(usableRedirect(undefined)).toBeNull()
    expect(usableRedirect(null)).toBeNull()
    expect(usableRedirect('')).toBeNull()
    expect(usableRedirect('keys')).toBeNull()
    expect(usableRedirect('https://evil.example/')).toBeNull()
    expect(usableRedirect('//evil.example/')).toBeNull()
  })

  it('never bounces back into the public pages', () => {
    expect(usableRedirect('/login')).toBeNull()
    expect(usableRedirect('/login?redirect=%2Fkeys')).toBeNull()
    expect(usableRedirect('/welcome')).toBeNull()
    expect(usableRedirect('/welcome?setup=true')).toBeNull()
    // The check is a word boundary, kept exactly as it was: a hyphen ends the word, letters do not.
    expect(usableRedirect('/welcome-pack')).toBeNull()
    expect(usableRedirect('/welcomes')).toBe('/welcomes')
    expect(usableRedirect('/loginx')).toBe('/loginx')
  })
})

describe('resolveSignInDestination', () => {
  it('goes to the deep link even when the account has not used the welcome guide, without asking onboarding', async () => {
    const needsWelcome = vi.fn(async () => true)
    await expect(
      resolveSignInDestination('/keys', needsWelcome)
    ).resolves.toEqual({ kind: 'redirect', href: '/keys' })
    // The bug: the onboarding request used to run first and send the user to /welcome, losing the link.
    expect(needsWelcome).not.toHaveBeenCalled()
  })

  it('without a usable redirect, an account that needs the guide goes to the welcome page', async () => {
    const needsWelcome = vi.fn(async () => true)
    await expect(
      resolveSignInDestination(undefined, needsWelcome)
    ).resolves.toEqual({ kind: 'welcome' })
    expect(needsWelcome).toHaveBeenCalledTimes(1)
  })

  it('without a usable redirect, a settled account goes to the overview', async () => {
    await expect(
      resolveSignInDestination(undefined, async () => false)
    ).resolves.toEqual({ kind: 'overview' })
  })

  it('a refused redirect behaves as if there were none', async () => {
    const needsWelcome = vi.fn(async () => true)
    await expect(
      resolveSignInDestination('//evil.example/', needsWelcome)
    ).resolves.toEqual({ kind: 'welcome' })
    await expect(
      resolveSignInDestination('/welcome', async () => false)
    ).resolves.toEqual({ kind: 'overview' })
    expect(needsWelcome).toHaveBeenCalledTimes(1)
  })
})
