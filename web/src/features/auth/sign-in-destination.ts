/**
 * Where a successful sign-in goes next. Kept free of React and of any request so the one rule that
 * matters can be tested on its own: a usable `redirect` wins over the welcome guide, and finding that
 * out must not need the onboarding request at all.
 */

/** `redirect` is a router href (`/vm/x?tab=y`); never bounce back into the public pages. */
export function usableRedirect(next: string | undefined | null): string | null {
  if (
    next &&
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !/^\/(welcome|login)\b/.test(next)
  ) {
    return next
  }
  return null
}

export type SignInDestination =
  | { kind: 'redirect'; href: string }
  | { kind: 'welcome' }
  | { kind: 'overview' }

/**
 * `needsWelcome` is read lazily: it is only called when there is no usable redirect, so a deep link
 * never waits for (or depends on) the onboarding request.
 */
export async function resolveSignInDestination(
  redirect: string | undefined | null,
  needsWelcome: () => Promise<boolean>
): Promise<SignInDestination> {
  const href = usableRedirect(redirect)
  if (href) return { kind: 'redirect', href }
  return (await needsWelcome()) ? { kind: 'welcome' } : { kind: 'overview' }
}
