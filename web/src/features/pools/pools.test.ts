import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  SchedulerExplainResponse,
  SchedulerPool,
} from '@/types/panel-pools'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StickyPane } from '@/features/settings/sticky-pane'
import {
  analyzeMemberConflicts,
  buildPoolPayload,
  createDefaultPoolDraft,
  defaultSystemPromptModeForProvider,
  formatExplainSummary,
  formatTtlLabel,
  isPromptLockedProvider,
  normalizePoolPromptPreset,
  normalizeProviderScope,
  POOL_LOCKED_DEFAULTS,
  poolToDraft,
  secondsToTtlParts,
  SYSTEM_PROMPT_MAX_BYTES,
  ttlPartsToSeconds,
  validateFallbackPool,
  validatePoolPromptPolicy,
} from './pool-rules'
import { PoolPromptTab } from './prompt-tab'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) =>
    createElement('a', null, children as never),
}))

function makePool(overrides: Partial<SchedulerPool> = {}): SchedulerPool {
  return {
    id: 'pool_aaaaaaaa',
    slug: 'pool-a',
    name: 'Pool A',
    description: '',
    enabled: true,
    exclusive_members: false,
    provider_scope: 'anthropic',
    plan_tags: ['max_20x'],
    pool_role: 'primary',
    sort_order: 0,
    fallback_pool_id: null,
    allow_cross_prompt_fallback: false,
    intra_tier_strategy: 'least_inflight_swrr',
    session_queue_max: 16,
    session_queue_timeout_ms: 60000,
    queue_wait_ms: 15000,
    queue_max: 50,
    machine_sticky_enabled: true,
    machine_ttl_seconds: 604800,
    session_sticky_enabled: true,
    session_ttl_seconds: 86400,
    session_busy_wait_ms: 0,
    session_overflow_policy: 'spill_immediately',
    system_prompt_mode: 'official',
    system_prompt_preset: 'official_full',
    system_prompt_text: '',
    client_system_policy: 'prepend_pool',
    jev_profile: 'inherit_global',
    members: [],
    ...overrides,
  }
}

describe('v4 locked defaults & provider prompt lock', () => {
  it('enforces all v4 locked default values on new pool drafts', () => {
    expect(POOL_LOCKED_DEFAULTS.exclusive_members).toBe(false)
    expect(POOL_LOCKED_DEFAULTS.session_overflow_policy).toBe(
      'spill_immediately'
    )
    expect(POOL_LOCKED_DEFAULTS.session_busy_wait_ms).toBe(0)
    expect(POOL_LOCKED_DEFAULTS.machine_ttl_seconds).toBe(604800)
    expect(POOL_LOCKED_DEFAULTS.session_ttl_seconds).toBe(86400)
    expect(POOL_LOCKED_DEFAULTS.session_queue_max).toBe(16)
    expect(POOL_LOCKED_DEFAULTS.session_queue_timeout_ms).toBe(60000)
    expect(POOL_LOCKED_DEFAULTS.system_prompt_mode).toBe('inherit_global')

    const draft = createDefaultPoolDraft()
    expect(draft.exclusive_members).toBe(false)
    expect(draft.session_overflow_policy).toBe('spill_immediately')
    expect(draft.session_busy_wait_ms).toBe(0)
    expect(draft.machine_ttl_seconds).toBe(604800)
    expect(draft.session_ttl_seconds).toBe(86400)
    expect(draft.session_queue_max).toBe(16)
    expect(draft.session_queue_timeout_ms).toBe(60000)
    expect(draft.system_prompt_mode).toBe('inherit_global')

    expect(defaultSystemPromptModeForProvider('anthropic')).toBe(
      'inherit_global'
    )
    expect(defaultSystemPromptModeForProvider('mixed')).toBe('inherit_global')
    expect(defaultSystemPromptModeForProvider('api')).toBe('inherit_global')
    expect(defaultSystemPromptModeForProvider('openai')).toBe('passthrough')
    expect(defaultSystemPromptModeForProvider('google')).toBe('passthrough')
    expect(defaultSystemPromptModeForProvider('gemini')).toBe('passthrough')

    expect(
      createDefaultPoolDraft({ provider_scope: 'mixed' }).system_prompt_mode
    ).toBe('inherit_global')
    expect(
      createDefaultPoolDraft({ provider_scope: 'api' }).system_prompt_mode
    ).toBe('inherit_global')
    expect(
      createDefaultPoolDraft({ provider_scope: 'openai' }).system_prompt_mode
    ).toBe('passthrough')
    expect(
      createDefaultPoolDraft({ provider_scope: 'google' }).system_prompt_mode
    ).toBe('passthrough')

    const missingModeDraft = poolToDraft(
      makePool({
        provider_scope: 'anthropic',
        system_prompt_mode: '' as SchedulerPool['system_prompt_mode'],
      })
    )
    expect(missingModeDraft.system_prompt_mode).toBe('inherit_global')

    // Retired official_303 canonicalizes cleanly to official_full on read & payload build
    expect(normalizePoolPromptPreset('official_303')).toBe('official_full')
    expect(normalizePoolPromptPreset('official')).toBe('official')
    expect(
      poolToDraft(
        makePool({
          system_prompt_preset:
            'official_303' as unknown as SchedulerPool['system_prompt_preset'],
        })
      ).system_prompt_preset
    ).toBe('official_full')
  })

  it('locks openai and google (including gemini alias) pools to passthrough', () => {
    expect(normalizeProviderScope('gemini')).toBe('google')
    expect(isPromptLockedProvider('openai')).toBe(true)
    expect(isPromptLockedProvider('google')).toBe(true)
    expect(isPromptLockedProvider('gemini')).toBe(true)
    expect(isPromptLockedProvider('anthropic')).toBe(false)
    expect(isPromptLockedProvider('mixed')).toBe(false)
    expect(isPromptLockedProvider('api')).toBe(false)

    for (const scope of ['openai', 'google'] as const) {
      const bad = validatePoolPromptPolicy({
        provider_scope: scope,
        system_prompt_mode: 'official',
      })
      expect(bad.ok).toBe(false)
      expect(bad.code).toBe('pool_prompt_unsupported_provider')

      const ok = validatePoolPromptPolicy({
        provider_scope: scope,
        system_prompt_mode: 'passthrough',
      })
      expect(ok.ok).toBe(true)

      const payload = buildPoolPayload({
        ...createDefaultPoolDraft({ provider_scope: scope }),
        name: `${scope}-pool`,
        system_prompt_mode: 'override',
        system_prompt_text: 'should be stripped',
      })
      expect(payload.system_prompt_mode).toBe('passthrough')
      expect(payload.system_prompt_text).toBe('')
    }
  })

  it('enforces 64 KiB UTF-8 limit on override/append prompt text', () => {
    const oversized = '中'.repeat(Math.ceil(SYSTEM_PROMPT_MAX_BYTES / 3) + 1)
    const res = validatePoolPromptPolicy({
      provider_scope: 'anthropic',
      system_prompt_mode: 'override',
      system_prompt_text: oversized,
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('prompt_too_large')
    expect(res.bytes).toBeGreaterThan(SYSTEM_PROMPT_MAX_BYTES)
  })

  it('hides System Prompt editor for openai/google pools and shows 6-mode selector for anthropic', () => {
    const qc = new QueryClient()
    const googleHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(PoolPromptTab, {
          pool: makePool({
            provider_scope: 'google',
            system_prompt_mode: 'passthrough',
          }),
        })
      )
    )
    expect(googleHtml).toContain(
      'OpenAI / Google 分组池不使用 System Prompt 注入（恒透传）'
    )
    expect(googleHtml).not.toContain('选择 Anthropic 池级 System Prompt 策略')

    const anthropicOverrideHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(PoolPromptTab, {
          pool: makePool({
            provider_scope: 'anthropic',
            system_prompt_mode: 'override',
            system_prompt_text: 'hello',
          }),
        })
      )
    )
    expect(anthropicOverrideHtml).toContain('官方提示词')
    expect(anthropicOverrideHtml).toContain('0 注入')
    expect(anthropicOverrideHtml).toContain('客户端自带 system 合并策略')

    const anthropicAppendHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(PoolPromptTab, {
          pool: makePool({
            provider_scope: 'anthropic',
            system_prompt_mode: 'append',
            system_prompt_text: 'tail',
          }),
        })
      )
    )
    expect(anthropicAppendHtml).not.toContain('客户端自带 system 合并策略')
  })
})

describe('TTL unit conversions', () => {
  it('converts between seconds and days/hours/minutes cleanly', () => {
    expect(secondsToTtlParts(604800, 'days')).toEqual({
      value: 7,
      unit: 'days',
    })
    expect(secondsToTtlParts(86400, 'hours')).toEqual({
      value: 24,
      unit: 'hours',
    })
    expect(secondsToTtlParts(1800)).toEqual({
      value: 30,
      unit: 'minutes',
    })
    expect(ttlPartsToSeconds(7, 'days')).toBe(604800)
    expect(ttlPartsToSeconds(24, 'hours')).toBe(86400)
    expect(ttlPartsToSeconds(15, 'minutes')).toBe(900)
    expect(formatTtlLabel(604800)).toBe('7 天')
    expect(formatTtlLabel(86400)).toBe('24 小时')
    expect(formatTtlLabel(3600)).toBe('1 小时')
    expect(formatTtlLabel(900)).toBe('15 分钟')
  })
})

describe('cross-pool member conflict & D1 risk rules', () => {
  const officialPool = makePool({
    id: 'pool_official',
    name: '官方提示词池',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    members: [
      {
        node_type: 'claude_vm',
        node_id: 'vm-crag-1',
        enabled: true,
        member_role: 'active',
        weight_tier_override: null,
        sub_weight_override: null,
        member_order: 0,
      },
      {
        node_type: 'claude_vm',
        node_id: 'vm-cli-1',
        enabled: true,
        member_role: 'active',
        weight_tier_override: null,
        sub_weight_override: null,
        member_order: 1,
      },
    ],
  })

  const zeroPool = makePool({
    id: 'pool_zero',
    name: '0注入池',
    provider_scope: 'anthropic',
    system_prompt_mode: 'zero_inject',
  })

  const exclusivePool = makePool({
    id: 'pool_exclusive',
    name: '高敏独享池',
    exclusive_members: true,
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
  })

  it('warns (but allows, D1) when Anthropic CRAG VM joins another Prompt mode pool', () => {
    const res = analyzeMemberConflicts({
      targetPool: zeroPool,
      candidate: {
        node_type: 'claude_vm',
        node_id: 'vm-crag-1',
        runtime_kind: 'crag',
      },
      allPools: [officialPool, zeroPool],
    })
    expect(res.level).toBe('warning')
    if (res.level === 'warning') {
      expect(res.reason).toBe('crag_cross_prompt')
      expect(res.message).toContain('风控警告')
      expect(res.message).toContain('官方提示词池')
    }
  })

  it('blocks old cli-node when joining a conflicting Prompt mode pool', () => {
    const res = analyzeMemberConflicts({
      targetPool: zeroPool,
      candidate: {
        node_type: 'claude_vm',
        node_id: 'vm-cli-1',
        runtime_kind: 'cli-node',
      },
      allPools: [officialPool, zeroPool],
    })
    expect(res.level).toBe('blocked')
    if (res.level === 'blocked') {
      expect(res.reason).toBe('cli_node_prompt_conflict')
    }
  })

  it('blocks reuse when exclusive_members is enabled on target or owning pool', () => {
    const targetExclusive = analyzeMemberConflicts({
      targetPool: exclusivePool,
      candidate: {
        node_type: 'claude_vm',
        node_id: 'vm-crag-1',
        runtime_kind: 'crag',
      },
      allPools: [officialPool, exclusivePool],
    })
    expect(targetExclusive.level).toBe('blocked')
    if (targetExclusive.level === 'blocked') {
      expect(targetExclusive.reason).toBe('exclusive_target')
    }

    const otherExclusivePool = makePool({
      ...exclusivePool,
      id: 'pool_other_exc',
      members: [
        {
          node_type: 'gemini_env',
          node_id: 'gem-1',
          enabled: true,
          member_role: 'active',
          weight_tier_override: null,
          sub_weight_override: null,
          member_order: 0,
        },
      ],
    })
    const ownerExclusive = analyzeMemberConflicts({
      targetPool: makePool({ id: 'pool_gem_2', provider_scope: 'google' }),
      candidate: {
        node_type: 'gemini_env',
        node_id: 'gem-1',
        runtime_kind: 'gemini',
      },
      allPools: [otherExclusivePool],
    })
    expect(ownerExclusive.level).toBe('blocked')
    if (ownerExclusive.level === 'blocked') {
      expect(ownerExclusive.reason).toBe('exclusive_other')
    }
  })

  it('validates fallback cycles, max depth 3, and cross-prompt guard', () => {
    const p1 = makePool({
      id: 'p1',
      name: 'P1',
      system_prompt_mode: 'official',
      fallback_pool_id: 'p2',
    })
    const p2 = makePool({
      id: 'p2',
      name: 'P2',
      system_prompt_mode: 'official',
      fallback_pool_id: 'p1',
    })
    const cycle = validateFallbackPool({
      sourcePool: p1,
      nextFallbackPoolId: 'p2',
      allPools: [p1, p2],
    })
    expect(cycle.ok).toBe(false)
    expect(cycle.error).toContain('环形引用')

    const crossPromptBlocked = validateFallbackPool({
      sourcePool: makePool({
        id: 'p1',
        system_prompt_mode: 'official',
        allow_cross_prompt_fallback: false,
      }),
      nextFallbackPoolId: 'pool_zero',
      allPools: [zeroPool],
    })
    expect(crossPromptBlocked.ok).toBe(false)
    expect(crossPromptBlocked.error).toContain('禁止跨 Prompt')

    const crossPromptAllowed = validateFallbackPool({
      sourcePool: makePool({
        id: 'p1',
        system_prompt_mode: 'official',
        allow_cross_prompt_fallback: true,
      }),
      nextFallbackPoolId: 'pool_zero',
      allPools: [zeroPool],
    })
    expect(crossPromptAllowed.ok).toBe(true)
    expect(crossPromptAllowed.warning).toContain('切换为目标池')
  })
})

describe('Explain result formatting', () => {
  it('formats hit pool, JEV downgrade, SessionGate state, affinity why, order and excluded codes', () => {
    const resp: SchedulerExplainResponse = {
      resolved_pool_id: 'pool_official',
      resolved_pool_name: '官方提示词池',
      jev_profile: 'enforce',
      jev_decision: { action: 'allow' },
      session_gate: { held: true, queue_depth: 2, queue_max: 16 },
      selected_node: {
        node_key: 'claude_vm:vm-02',
        name: 'VM-02',
        effective_weight_tier: 8,
        stood_in: true,
      },
      affinity: {
        why: 'SessionSpillBusy',
        stood_in: true,
        preserve_machine_home: true,
      },
      prompt_policy: { mode: 'official', applies: true },
      order: [
        {
          node_key: 'claude_vm:vm-02',
          effective_weight_tier: 8,
          selected: true,
        },
      ],
      excluded: [
        { node_key: 'claude_vm:vm-01', reason: 'cooldown' },
        { node_key: 'claude_vm:vm-03', reason: 'quota_exhausted' },
      ],
    }

    const summary = formatExplainSummary(resp)
    expect(summary.resolvedPoolLabel).toContain('官方提示词池')
    expect(summary.selectedNodeLabel).toContain('VM-02')
    expect(summary.selectedNodeLabel).toContain('T8')
    expect(summary.selectedNodeLabel).toContain('临时替补')
    expect(summary.affinityLabel).toContain('满了就换')
    expect(summary.gateLabel).toContain('FIFO 排队 2/16')
    expect(summary.jevLabel).toContain('放行')
    expect(summary.promptLabel).toBe('官方提示词')
    expect(summary.orderCount).toBe(1)
    expect(summary.excludedCount).toBe(2)
    expect(summary.excludedItems[0].reasonLabel).toBe('冷却中')
    expect(summary.excludedItems[1].reasonLabel).toContain('95%')
  })
})

describe('related page regressions (/system, /keys, /settings)', () => {
  it('/system no longer calls inheritProtocolOnSlots to wipe slot overrides on save', () => {
    const source = readFileSync(
      new URL('../system/index.tsx', import.meta.url),
      'utf8'
    )
    expect(source).not.toContain('inheritProtocolOnSlots')
    expect(source).not.toContain('patchVm')
    expect(source).toContain('继承全局')
    expect(source).toContain('/pools')
  })

  it('/keys removes inline VmPoolsCard and links to /pools', () => {
    const source = readFileSync(
      new URL('../keys/index.tsx', import.meta.url),
      'utf8'
    )
    expect(source).not.toContain('VmPoolsCard')
    expect(source).toContain("to='/pools'")
  })

  it('/settings StickyPane splits device TTL (7d) and session TTL (24h) without D3/D4 violations', () => {
    const source = readFileSync(
      new URL('../settings/sticky-pane.tsx', import.meta.url),
      'utf8'
    )
    expect(source).not.toContain('KIN_SCHEDULER_MODE')
    expect(source).not.toContain('fallback_node')
    expect(source).not.toContain('X-VM2API-Session-Id')

    const html = renderToStaticMarkup(
      createElement(StickyPane, {
        value: { enabled: true },
        onChange: () => {},
      })
    )
    expect(html).toContain('默认设备粘性 TTL')
    expect(html).toContain('7 天')
    expect(html).toContain('默认会话粘性 TTL')
    expect(html).toContain('24 小时')
  })
})
