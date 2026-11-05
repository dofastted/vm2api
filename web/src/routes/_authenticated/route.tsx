import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createFileRoute,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { ApiError } from '@/lib/api'
import { hasSession } from '@/lib/session'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { meQueryOptions } from '@/features/auth/queries'
import { FleetActions } from '@/features/fleet/fleet-actions'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ location }) => {
    if (!hasSession()) {
      // Bare console entry is the public welcome; deep links go to the sign-in page.
      if (location.pathname === '/') throw redirect({ to: '/welcome' })
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
  },
  component: Authenticated,
})

function Authenticated() {
  const navigate = useNavigate()
  const onKernelPage = useRouterState({
    select: (state) => state.location.pathname === '/wrap',
  })
  const meQuery = useQuery(meQueryOptions())
  const setMe = useAuthStore((s) => s.setMe)
  const signOut = useAuthStore((s) => s.signOut)
  useEffect(() => {
    if (meQuery.data) setMe(meQuery.data)
  }, [meQuery.data, setMe])
  useEffect(() => {
    if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
      signOut()
      navigate({ to: '/login' })
    }
  }, [meQuery.error, signOut, navigate])
  if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
    return null
  }
  return (
    <AuthenticatedLayout
      headerActions={onKernelPage ? null : <FleetActions />}
    />
  )
}
