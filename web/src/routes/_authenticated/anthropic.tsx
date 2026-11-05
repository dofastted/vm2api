import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/anthropic')({
  beforeLoad: () => {
    throw redirect({ to: '/api', replace: true })
  },
})
