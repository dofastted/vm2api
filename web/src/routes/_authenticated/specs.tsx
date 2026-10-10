import { createFileRoute } from '@tanstack/react-router'
import { SpecsPage } from '@/features/specs'

export const Route = createFileRoute('/_authenticated/specs')({
  component: SpecsPage,
})
