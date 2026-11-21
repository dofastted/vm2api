import { createFileRoute } from '@tanstack/react-router'
import { AccountPage } from '@/features/account'

export const Route = createFileRoute('/_authenticated/account')({
  component: AccountPage,
})
