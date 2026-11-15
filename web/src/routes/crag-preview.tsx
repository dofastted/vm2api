import { createFileRoute } from '@tanstack/react-router'
import { CragPreviewPage } from '@/features/billing/crag-preview'

// Public, API-free canvas embedded by the CRAG Auth plan editor.
export const Route = createFileRoute('/crag-preview')({
  component: CragPreviewPage,
})
