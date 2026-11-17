import type { ReactNode } from 'react'
import type * as ReactModule from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthenticatedLayout } from './authenticated-layout'

const mocks = vi.hoisted(() => ({
  guideUsed: false as boolean | undefined,
  effects: [] as (() => void)[],
  navigate: vi.fn(),
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useEffect: (effect: () => void) => mocks.effects.push(effect),
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { guide_used: mocks.guideUsed } }),
}))
vi.mock('@tanstack/react-router', () => ({
  Outlet: () => <main>requested page</main>,
  useNavigate: () => mocks.navigate,
}))
vi.mock('@/lib/cookies', () => ({ getCookie: () => undefined }))
vi.mock('@/features/welcome/queries', () => ({
  onboardingQueryOptions: () => ({ queryKey: ['onboarding'] }),
}))
vi.mock('@/context/layout-provider', () => ({
  LayoutProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/context/search-provider', () => ({
  SearchProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  SidebarInset: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@/components/layout/app-sidebar', () => ({ AppSidebar: () => null }))
vi.mock('@/components/layout/star-hint', () => ({ StarHint: () => null }))
vi.mock('@/components/skip-to-main', () => ({ SkipToMain: () => null }))

beforeEach(() => {
  mocks.effects.length = 0
  mocks.navigate.mockReset()
})

describe('authenticated console navigation', () => {
  it.each([false, true, undefined])(
    'keeps the requested page when guide_used is %s',
    (guideUsed) => {
      mocks.guideUsed = guideUsed
      const html = renderToStaticMarkup(<AuthenticatedLayout />)
      for (const effect of mocks.effects) effect()
      expect(html).toContain('requested page')
      expect(mocks.navigate).not.toHaveBeenCalled()
    }
  )
})
