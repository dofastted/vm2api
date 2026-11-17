import { createFileRoute } from '@tanstack/react-router'
import { ImportPage } from '@/features/import'

export const Route = createFileRoute('/_authenticated/import')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: search.tab === 'gemini' ? ('gemini' as const) : undefined,
  }),
  component: ImportPage,
})
