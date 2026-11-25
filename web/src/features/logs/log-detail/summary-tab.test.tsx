import type { UsageLogRow } from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SummaryTab } from './summary-tab'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

function baseRow(overrides: Partial<UsageLogRow> = {}): UsageLogRow {
  return {
    id: 'log_1',
    requestId: 'req_1',
    createdAt: '2026-11-26T00:00:00.000Z',
    userId: null,
    userName: null,
    keyId: null,
    keyName: null,
    sessionId: null,
    clientSessionId: null,
    inboundDeviceId: null,
    upstreamStatus: 409,
    providerName: null,
    accountId: null,
    vmId: 'vm-11',
    vmName: 'Slot 11',
    model: 'claude-sonnet-4-6',
    originalModel: 'claude-sonnet-4-6',
    actualResponseModel: null,
    modelMismatch: 0,
    endpoint: '/v1/messages',
    protocol: 'anthropic.messages',
    method: 'POST',
    statusCode: 409,
    logMode: 'normal',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheTtlApplied: null,
    totalTokens: 0,
    costUsd: null,
    actualCostUsd: null,
    groupCostMultiplier: null,
    costBreakdown: null,
    durationMs: 120,
    firstByteMs: null,
    ttftMs: null,
    generationMs: null,
    stopReason: null,
    attemptCount: 1,
    finalState: 'rejected',
    via: 'rust-kernel',
    stream: false,
    hasTools: false,
    serviceTier: null,
    upstreamServiceTier: null,
    speed: null,
    context1mApplied: null,
    reasoningEffort: null,
    errorClass: 'request',
    errorLabel: '请求格式',
    errorOwner: 'client',
    errorCode: 'partial_provider_output_nonretryable',
    errorMessage: 'Provider output interrupted',
    upstreamType: 'partial_provider_output_nonretryable',
    errorDetails: {
      upstream_type: 'partial_provider_output_nonretryable',
      retryable: false,
      prior_reason: 'client_cancelled',
      interrupted_at: 1795495209,
      retry_after_sec: 20,
      recovery_attempts: 1,
      max_recoveries: 2,
      recovery_exhausted: false,
    },
    jevState: null,
    blockedBy: null,
    blockedReason: null,
    userAgent: null,
    clientIp: null,
    apiKeyPresented: null,
    specialSettings: [],
    providerChain: [],
    ...overrides,
  }
}

describe('SummaryTab structured error diagnostics (#1845)', () => {
  it('renders upstreamType and #1705 errorDetails badges in normal mode', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SummaryTab row={baseRow()} scrollToRedirect={false} />
      </TooltipProvider>
    )
    expect(html).toContain('partial_provider_output_nonretryable')
    expect(html).toContain('prior_reason=client_cancelled')
    expect(html).toContain('retry_after_sec=20')
    expect(html).toContain('recovery_attempts=1')
    expect(html).toContain('max_recoveries=2')
    expect(html).toContain('recovery_exhausted=false')
  })
})
