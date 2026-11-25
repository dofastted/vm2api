import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LogsPane } from './logs-pane'
import { OpenaiPane } from './openai-pane'
import { ProtocolPane } from './protocol-pane'
import { QuotaTierPane } from './quota-tier-pane'
import { RedactionPane } from './redaction-pane'
import {
  DEFAULT_CODEX_USER_AGENT as DEFAULT_USER_AGENT,
  FAILOVER_DEFAULTS,
  REDACTION_RULE_LIMIT,
  REDACTION_WORD_LIMIT,
  buildRoutingSavePayload,
  changedRoutingSections,
  codexCatalogVersionError,
  computePendingCards,
  computeSettingsBlockedReason,
  dirtySettingsTabLabels,
  effectiveSeatCap,
  exhaustionGuardOrderError,
  settingsSaveToast,
  validateLoggingDraft,
  validateRedactionDraft,
} from './routing-draft'
import { StickyPane } from './sticky-pane'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string
    params?: Record<string, string>
    children: React.ReactNode
    className?: string
  }) => (
    <a
      data-router-to={to}
      data-router-params={params ? JSON.stringify(params) : undefined}
      className={className}
    >
      {children}
    </a>
  ),
}))

describe('P1-01 & P2-01: routing draft normalization, preservation, and cross-tab toasts', () => {
  it('preserves unexposed compatibility fields instead of clobbering overlay_preset/cache_breakpoints', () => {
    const server = {
      compatibility: {
        persona_preset: 'official_full',
        overlay_preset: 'minimal',
        persona_park: true,
        cache_ttl: '1h',
        cache_breakpoints: {
          enabled: true,
          preserve_client: true,
          system_tail: true,
          tools_tail: true,
          messages: 'custom',
        },
        count_tokens: false,
      },
      redaction_runtime: { enabled: false, ready: true },
      max_body_bytes: 33554432,
      max_body_mib: 32,
    }
    const draft = {
      ...server,
      compatibility: {
        ...server.compatibility,
        count_tokens: true,
      },
    }
    const { body, changedSections } = buildRoutingSavePayload(draft, server)
    expect(changedSections.has('compatibility')).toBe(true)
    expect(body.redaction_runtime).toBeUndefined()
    expect(body.max_body_bytes).toBeUndefined()
    expect(body.max_body_mib).toBeUndefined()
    const compat = body.compatibility as Record<string, unknown>
    expect(compat.overlay_preset).toBe('minimal')
    expect(compat.persona_park).toBe(true)
    expect(compat.cache_breakpoints).toEqual(
      server.compatibility.cache_breakpoints
    )
    expect(compat.count_tokens).toBe(true)
  })

  it('does not call inheritProtocolOnSlots from SettingsPage source', () => {
    const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('inheritProtocolOnSlots')
  })

  it('keys toasts and warnings off changed sections & server results, including telemetry fleet opt-in and kernel skipped warnings', () => {
    const failedTelemetry = settingsSaveToast({
      changedSections: new Set(['telemetry']),
      telemetryOptIn: true,
      saved: {
        telemetry_sync: {
          updated: 2,
          opted_in: 3,
          failed: ['vm-remote-1'],
        },
      },
    })
    expect(failedTelemetry.level).toBe('warning')
    expect(failedTelemetry.message).toContain('批量开启遥测（3 个）')
    expect(failedTelemetry.message).toContain('已确认发布 2 个 VM')
    expect(failedTelemetry.message).toContain('1 个未生效：vm-remote-1')

    const kernelSkipped = settingsSaveToast({
      changedSections: new Set(['compatibility']),
      saved: {
        kernel_persona: { updated: 0, skipped: 2 },
      },
    })
    expect(kernelSkipped.level).toBe('warning')
    expect(kernelSkipped.message).toContain('2 个槽 kernel 配置跳过或同步失败')
    expect(kernelSkipped.message).not.toContain('kernel 配置已一致')

    const kernelConsistent = settingsSaveToast({
      changedSections: new Set(['compatibility']),
      saved: {
        kernel_persona: { updated: 0, skipped: 0 },
      },
    })
    expect(kernelConsistent.level).toBe('success')
    expect(kernelConsistent.message).toContain('kernel 配置已一致')
  })

  it('tracks dirty tabs accurately and ignores read-only metadata changes', () => {
    const server = {
      sticky: { enabled: true, ttl_seconds: 86400 },
      redaction_runtime: { enabled: false, ready: true },
      sessions: { total: 1 },
      max_body_mib: 32,
    }
    const unchanged = {
      ...server,
      sessions: { total: 99 },
      redaction_runtime: { enabled: true, ready: true },
    }
    expect(changedRoutingSections(unchanged, server).size).toBe(0)

    const dirtyDraft = {
      ...server,
      sticky: { enabled: false, ttl_seconds: 86400 },
    }
    expect(dirtySettingsTabLabels(dirtyDraft, server)).toEqual(['粘性'])
  })
})

describe('P1-02: StickyPane copy distinguishes routing affinity from seat occupancy', () => {
  it('explains immediate seat release and references protocol idle timeout', () => {
    const html = renderToStaticMarkup(
      <StickyPane
        value={{ enabled: true, ttl_seconds: 86400 }}
        onChange={() => {}}
      />
    )
    expect(html).toContain('单轮结束即归还并发池席位')
    expect(html).toContain('仅记忆 session → VM 路由亲和，不占并发池席位')
    expect(html).toContain('协议 → 槽空闲超时')
    expect(html).not.toContain('session 占着的槽位跟这个绑定一起留')
    expect(html).not.toContain('也是请求结束后 session 继续占槽的时间')
  })
})

describe('P1-03, P2-04 & P2-05: PoolPane defaults, seatCap, no seat_grace_ms, router Links', () => {
  it('matches routing.json failover defaults and PoolScheduler familyLimitsOf seatCap', () => {
    expect(FAILOVER_DEFAULTS.max_account_switches).toBe(3)
    expect(FAILOVER_DEFAULTS.max_same_account_retries).toBe(3)
    expect(
      effectiveSeatCap(
        { max_primary_sessions: 5, max_subagents_per_session: null },
        { session_slots: 20 }
      )
    ).toBe(20)
    expect(
      effectiveSeatCap(
        { max_primary_sessions: 5, max_subagents_per_session: 2 },
        { session_slots: 20 }
      )
    ).toBe(5)
    expect(
      effectiveSeatCap(
        { max_primary_sessions: null, max_subagents_per_session: 2 },
        { session_slots: 12 }
      )
    ).toBe(12)
  })

  it('removes seat_grace_ms slider and hardcoded /console/#/ anchors from PoolPane', () => {
    const source = readFileSync(
      new URL('./pool-pane.tsx', import.meta.url),
      'utf8'
    )
    expect(source).not.toContain('seat_grace_ms')
    expect(source).not.toContain('旧席位宽限')
    expect(source).not.toContain("href='/console/#/vm'")
    expect(source).not.toContain("href='/console/#/settings/sticky'")
    expect(source).toContain("to='/vm'")
    expect(source).toContain("to='/settings/$tab'")
  })
})

describe('P2-06 & P2-07: QuotaTierPane exhaustion ordering and KIN_MAX_BODY ceiling', () => {
  it('flags exhaustion_guard_new_session > exhaustion_guard_stop', () => {
    expect(
      exhaustionGuardOrderError({
        exhaustion_guard_new_session: 0.95,
        exhaustion_guard_stop: 0.8,
      })
    ).toContain('不能高于')
    expect(
      exhaustionGuardOrderError({
        exhaustion_guard_new_session: 0.85,
        exhaustion_guard_stop: 0.85,
      })
    ).toBeNull()
  })

  it('renders KIN_MAX_BODY ceiling warning and calibrated reload timing copy', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <QuotaTierPane
          tiers={{}}
          quota={{}}
          failover={{ max_request_mib: 64 }}
          maxBodyMib={32}
          onChange={() => {}}
          onQuotaChange={() => {}}
          onFailoverChange={() => {}}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('KIN_MAX_BODY 上限（32 MiB）')
    expect(html).toContain('codex-kernel 在下次空闲请求时应用新上限')
  })
})

describe('P2-08: OpenaiPane catalog version validation and empty-on-blur fallback', () => {
  it('validates catalog_client_version and normalizes empty strings on save', () => {
    expect(codexCatalogVersionError('auto')).toBeNull()
    expect(codexCatalogVersionError('0.170.0')).toBeNull()
    expect(codexCatalogVersionError('v0.171.0')).toBeNull()
    expect(codexCatalogVersionError('')).toBeNull()
    expect(codexCatalogVersionError('latest')).toContain('语义版本号')
    expect(codexCatalogVersionError('0.170')).toContain('语义版本号')

    const { body } = buildRoutingSavePayload(
      { codex: { catalog_client_version: '   ', user_agent: '  ' } },
      {
        codex: {
          catalog_client_version: 'auto',
          user_agent: DEFAULT_USER_AGENT,
        },
      }
    )
    expect((body.codex as Record<string, unknown>).catalog_client_version).toBe(
      'auto'
    )
    expect((body.codex as Record<string, unknown>).user_agent).toBe(
      DEFAULT_USER_AGENT
    )
  })

  it('renders inline validation error when catalog_client_version is invalid', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <OpenaiPane
          websocket={{ enabled: true }}
          codex={{ catalog_client_version: 'latest', user_agent: '' }}
          onWebsocketChange={() => {}}
          onCodexChange={() => {}}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('仅支持 auto 或语义版本号')
  })
})

describe('P2-09: ProtocolPane calibrated engine scope and model catalog window copy', () => {
  it('distinguishes cli-node/cli-hop from full CRAG v2 and references model catalog default window', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ProtocolPane
          compat={{}}
          inference={{}}
          onCompatChange={() => {}}
          onInferenceChange={() => {}}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('完整 CRAG v2')
    expect(html).toContain('完整 CRAG v2 槽不按此项回收空闲会话')
    expect(html).toContain('模型目录（model catalog）')
    expect(html).toContain('4.6 / 4.7 / 5.x / Fable / Mythos')
  })
})

describe('P1-04 & P2-10: RedactionPane empty policy, empty rule, and limit validation', () => {
  it('blocks enabled policy with nothing to protect and blank custom rules', () => {
    const emptyPolicy = validateRedactionDraft({
      enabled: true,
      secrets: false,
      personal: false,
      words: ['   '],
      rules: [],
    })
    expect(emptyPolicy.emptyPolicyError).toBeTruthy()
    expect(emptyPolicy.blockingError).toBe(emptyPolicy.emptyPolicyError)

    const blankRule = validateRedactionDraft({
      enabled: true,
      secrets: true,
      personal: true,
      words: [],
      rules: [{ kind: 'KEY', prefix: '', regex: '' }],
    })
    expect(blankRule.ruleErrors[0]).toContain('不能为空')
    expect(blankRule.blockingError).toContain('不能为空')

    const tooManyWords = validateRedactionDraft({
      enabled: true,
      secrets: true,
      personal: true,
      words: Array.from(
        { length: REDACTION_WORD_LIMIT + 1 },
        (_, i) => `word_${i}`
      ),
      rules: [],
    })
    expect(tooManyWords.wordsError).toContain(String(REDACTION_WORD_LIMIT))

    const html = renderToStaticMarkup(
      <RedactionPane
        redaction={{
          enabled: true,
          secrets: false,
          personal: false,
          words: [],
          rules: [{ kind: 'EMPTY', prefix: '', regex: '' }],
          allow: [],
        }}
        runtime={{ enabled: false, ready: true }}
        onChange={() => {}}
      />
    )
    expect(html).toContain(`0 / ${REDACTION_WORD_LIMIT}`)
    expect(html).toContain(`1 / ${REDACTION_RULE_LIMIT}`)
    expect(html).toContain('内容不能为空')
  })
})

describe('P2-13: LogsPane MiB labeling and retention/size validation', () => {
  it('validates retain_days, debug_retain_days <= retain_days, and max_mb <= 102400', () => {
    expect(
      validateLoggingDraft({
        retain_days: 7,
        debug_retain_days: 3,
        max_mb: 2048,
      }).blockingError
    ).toBeNull()
    expect(
      validateLoggingDraft({
        retain_days: 0,
        debug_retain_days: 1,
        max_mb: 2048,
      }).retainDaysError
    ).toContain('1–90')
    expect(
      validateLoggingDraft({
        retain_days: 5,
        debug_retain_days: 6,
        max_mb: 2048,
      }).debugRetainDaysError
    ).toContain('不能大于保留天数')
    expect(
      validateLoggingDraft({
        retain_days: 7,
        debug_retain_days: 3,
        max_mb: 102401,
      }).maxMbError
    ).toContain('102400')

    const html = renderToStaticMarkup(
      <LogsPane
        value={{
          mode: 'normal',
          retain_days: 5,
          debug_retain_days: 6,
          max_mb: 2048,
        }}
        onChange={() => {}}
      />
    )
    expect(html).toContain('Debug 载荷上限 (MiB)')
    expect(html).not.toContain('存储上限 MB')
    expect(html).toContain('不能大于保留天数')
    expect(html).toContain('每 10 分钟')
    expect(html).toContain('归档')
  })

  it('surfaces logging/redaction/openai errors in computeSettingsBlockedReason', () => {
    const blocked = computeSettingsBlockedReason(
      { logging: { retain_days: 5, debug_retain_days: 8, max_mb: 1024 } },
      new Set(['logging'])
    )
    expect(blocked).toContain('不能大于保留天数')
  })
})

describe('P3-02: per-card pending badges reflect only the edited card slice', () => {
  it('marks only the single edited card pending across all 13 cards', () => {
    const server = {
      sticky: {
        enabled: true,
        ttl_seconds: 86400,
        outbound_session: 'rebuild',
      },
      pool: {
        strategy: 'balanced',
        reset_priority: true,
        queue_max: 50,
        sticky_wait_timeout_ms: 45000,
        fallback_wait_timeout_ms: 30000,
        seat_budget_reserve_pct: 0.02,
      },
      inference: { session_slots: 20, prewarm_enabled: false },
      tiers: {
        default: {
          limit_5h: 0.85,
          limit_7d: 0.8,
          max_concurrency: 2,
          max_rpm: 0,
        },
        pro: { limit_5h: 0.85, limit_7d: 0.8, max_concurrency: 2, max_rpm: 0 },
        max: { limit_5h: 0.95, limit_7d: 0.95, max_concurrency: 4, max_rpm: 0 },
      },
      quota: { block_on_5h: true, block_on_7d: true },
      codex: {
        quota: {
          limit_5h: 1,
          limit_7d: 1,
          max_concurrency: 2,
          max_rpm: 0,
          max_sessions: 0,
        },
      },
    }

    // Editing only sticky.ttl_seconds must ONLY flip sticky.ttl
    const draft = {
      ...server,
      sticky: { ...server.sticky, ttl_seconds: 3600 },
    }
    const pending = computePendingCards(draft, server)
    expect(pending).toEqual({
      sticky: { binding: false, ttl: true, outbound: false },
      pool: { strategy: false, seats: false, queue: false },
      quota: { gates: false, concurrency: false, rpm: false },
      openai: {
        gates: false,
        concurrency: false,
        rpm: false,
        sessions: false,
      },
    })

    // Editing only codex.quota.max_sessions must ONLY flip openai.sessions
    const openaiDraft = {
      ...server,
      codex: {
        quota: { ...server.codex.quota, max_sessions: 8 },
      },
    }
    expect(computePendingCards(openaiDraft, server)).toEqual({
      sticky: { binding: false, ttl: false, outbound: false },
      pool: { strategy: false, seats: false, queue: false },
      quota: { gates: false, concurrency: false, rpm: false },
      openai: {
        gates: false,
        concurrency: false,
        rpm: false,
        sessions: true,
      },
    })
  })
})
