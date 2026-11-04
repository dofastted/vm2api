import { createFileRoute } from '@tanstack/react-router'
import { AnthropicConsolePage } from '@/features/anthropic'

export const Route = createFileRoute('/_authenticated/api')({
  component: AnthropicConsolePage,
})
