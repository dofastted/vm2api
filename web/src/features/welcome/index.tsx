/**
 * Public console landing: floating header, gradient hero with an API demo,
 * bento features, three steps, and a CTA. Tokens are scoped by
 * `.welcome-theme` so the console keeps its own theme. After sign-in the live
 * setup checklist sits under the hero.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { meQueryOptions } from '@/features/auth/queries'
import { WelcomeCapabilities } from './capabilities'
import { WelcomeChecklist } from './checklist'
import { WelcomeClientSnippets } from './client-snippets'
import { WelcomeCta, WelcomeFooter } from './cta'
import { WelcomeHero } from './hero'
import { WelcomeModuleGuide } from './module-guide'
import { onboardingQueryOptions } from './queries'
import { WelcomeQuickStart } from './quick-start'
import { scrollToSection } from './scroll'
import { WelcomeStats } from './stats'
import { WelcomeTopBar } from './top-bar'
import { WelcomeUsageMode } from './usage-mode'

export function WelcomePage() {
  const search = useSearch({ from: '/welcome' })
  const token = useAuthStore((s) => s.token)
  const username = useAuthStore((s) => s.user)
  const signedIn = Boolean(token)

  const onboarding = useQuery(onboardingQueryOptions(signedIn))
  const me = useQuery(meQueryOptions(signedIn))

  // Sign-in lands here with `?setup=1`. The router resets scroll right after the
  // navigation commits, so the jump waits a beat to not be overwritten.
  useEffect(() => {
    if (!search.setup || !onboarding.data) return
    const timer = window.setTimeout(() => scrollToSection('welcome-setup'), 120)
    return () => window.clearTimeout(timer)
  }, [search.setup, onboarding.data])

  const base =
    (onboarding.data?.base_url || '').replace(/\/$/, '') || location.origin

  return (
    <div className='welcome-theme min-h-svh overflow-x-hidden bg-background text-foreground'>
      <WelcomeTopBar signedIn={signedIn} username={username} />
      <main>
        <WelcomeHero signedIn={signedIn} baseUrl={base} />
        {signedIn && onboarding.data ? (
          <>
            {me.data?.role === 'admin' ? (
              <WelcomeUsageMode profile={onboarding.data.profile ?? null} />
            ) : null}
            <WelcomeChecklist
              payload={onboarding.data}
              views={me.data?.views}
            />
            <WelcomeModuleGuide views={me.data?.views} />
          </>
        ) : null}
        <WelcomeStats />
        <WelcomeCapabilities />
        <WelcomeQuickStart />
        <WelcomeClientSnippets baseUrl={base} />
        <WelcomeCta signedIn={signedIn} />
      </main>
      <WelcomeFooter />
    </div>
  )
}
