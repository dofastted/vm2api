import { createFileRoute } from '@tanstack/react-router'
import { RiskAuditPage } from '@/features/risk'
import { riskSearch } from '@/features/risk/model'

export const Route = createFileRoute('/_authenticated/risk')({
  validateSearch: riskSearch,
  component: RiskAuditPage,
})
