import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SlotIdentity } from '@/components/platform-chip'
import { restrictionTitle } from './clear-restriction'
import { FleetPulse } from './fleet-pulse'
import { geminiSlot } from './gemini-slot'
import { VmTable } from './vm-list-table'
import { canReclaimVm } from './vm-owner'
import { VmRack } from './vm-rack'
import { bladeState, vmWindows, zoneCounts } from './vm-rack-model'
import { VmRowDetail } from './vm-row-detail'
import { VmSchedulingBlock, VmSchedulingEditor } from './vm-scheduling'
import { filterVms, sortVms } from './vm-table'

vi.mock('./vm-actions-context', () => ({ useVmActions: () => ({}) }))
vi.mock('./vm-action-menu', () => ({ VmActionMenu: () => null }))
vi.mock('./vm-owner-line', () => ({ VmRentedMark: () => null }))
vi.mock('./vm-perms', () => ({ useVmPerms: () => ({ admin: false }) }))
vi.mock('./use-vm-column-order', () => ({
  useVmColumnOrder: () => ({
    order: ['vm', 'sched', 'status'],
    isDefault: true,
  }),
}))
vi.mock('@/components/ui/dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/dialog')>()),
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function render(over: Partial<Vm> = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <VmTable vms={[{ id: 'vm-01', email: 'account@example.com', ...over }]} />
    </QueryClientProvider>
  )
}

describe('VM scheduling priority', () => {
  it('groups the three Claude seat PATCH fields under one VM type check', () => {
    const source = readFileSync(
      new URL('./vm-scheduling.tsx', import.meta.url),
      'utf8'
    )
    const guards = [...source.matchAll(/if \(!isCodexVm\(vm\)\) \{([^}]+)\}/g)]
    const fields = [
      'session_slots',
      'max_primary_sessions',
      'max_subagents_per_session',
    ]
    expect(
      guards.some(([, block]) =>
        fields.every((field) => block.includes(`knob('${field}',`))
      )
    ).toBe(true)
  })

  it.each(['anthropic', 'openai'] as const)(
    'shows and edits the same %s priority throughout the panel',
    (platform) => {
      const vm: Vm = {
        id: 'vm-01',
        platform,
        schedule_level: 8,
        schedule_level_mode: 'manual',
        weight: 42,
      }
      const list = render(vm)
      expect(list).toContain('>调度 · 优先级</div>')
      expect(list).toMatch(
        /text-blue-800[^"]*shadow-\[inset_0_0_0_1px_currentColor\][^"]*"[^>]*>P8</
      )
      expect(list).not.toMatch(/等级|权重/)

      const detail = renderToStaticMarkup(<VmSchedulingBlock vm={vm} />)
      expect(detail).toContain('>调度优先级</span>')
      expect(detail).toContain('>8 · 手动</span>')

      const editor = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <VmSchedulingEditor vm={vm} />
        </QueryClientProvider>
      )
      expect(editor).toContain('role="radiogroup" aria-label="调度优先级"')
      expect(editor).toMatch(/role="radio" aria-checked="true"[^>]*>8</)
    }
  )

  it('does not substitute legacy weight when priority is missing', () => {
    expect(render({ weight: 4 })).toMatch(/>P—</)
  })
})

describe('VM row interaction and health', () => {
  it('shows family limits and the waiting children on a Claude root seat', () => {
    const vm: Vm = {
      id: 'vm-01',
      session_slots: 6,
      seats_max: 2,
      max_primary_sessions: 2,
      max_primary_sessions_override: true,
      max_subagents_per_session: 0,
      max_subagents_per_session_override: true,
      seat_sessions: [
        {
          index: 0,
          session_id: 'root',
          state: 'idle',
          inflight: 0,
          subagents_running: 0,
          subagents_queued: 2,
          subagents_max: 0,
        },
      ],
    }
    const block = renderToStaticMarkup(<VmSchedulingBlock vm={vm} />)
    expect(block).toContain('主会话上限')
    expect(block).toContain('子代理 0/0 · 排队 2')
    expect(block).toContain('本槽钉住；全局 关闭')
    expect(
      renderToStaticMarkup(<VmSchedulingBlock vm={{ id: 'legacy' }} />)
    ).toContain('关闭(子代理各占一个执行位)')
    const editor = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <VmSchedulingEditor vm={vm} />
      </QueryClientProvider>
    )
    expect(editor).toContain('默认控制同时占用的物理执行位数')
    expect(editor).toContain('跟随 · 6')
    expect(editor).toMatch(/<select[^>]*aria-label="每会话子代理上限"/)
    expect(editor).toContain('<option value="20">20</option>')
  })
  it('opens detail from a left button and exposes a separate expand control', () => {
    const html = render()
    expect(html).toContain('aria-label="打开 vm-01 详情页"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls="vm-row-detail-vm-01"')
    expect(html).not.toContain('role="button"')
  })

  it('shows request success rate and never infers health without requests', () => {
    const buckets = Array.from({ length: 48 }, (_, i): [number, number] =>
      i === 47 ? [99, 1] : [0, 0]
    )
    const html = render({ health_24h: buckets })
    expect(html).toContain('>99.0%</b>')
    expect(html).toContain('>99/100</span>')
    expect(render({ health_24h: null })).toContain('24h 无请求')
    expect(render({ health_24h: null })).not.toContain('主机内存紧张')
  })
})

describe('VM account column kernel label', () => {
  it('shares the VM table and rack with a host Gemini account without VM controls or fake readiness', () => {
    const gemini = geminiSlot({
      id: 'gemini-fixture',
      name: 'Gemini account',
      proxy_id: 'px-011f7746',
      auth_state: 'authorized',
      runtime_ready: false,
      billing_ready: false,
      auth_method: 'oauth',
      kernel_version: '0.3.0-rc.1',
      created_at: null,
      updated_at: null,
      models: [],
      account: null,
    })
    expect(filterVms([gemini], 'px-011f', 'dead', 'gemini')).toEqual([gemini])
    expect(filterVms([gemini], '', 'all', 'gpt')).toEqual([])
    expect(filterVms([gemini], '', 'all', 'claude')).toEqual([])

    const openai = { id: 'vm-02', platform: 'openai', has_token: true }
    const renderSlots = (nodes: ReactNode) =>
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          {nodes}
        </QueryClientProvider>
      )
    const table = renderSlots(<VmTable vms={[openai, gemini]} />)
    expect(table).toContain('aria-label="openai"')
    expect(table).toContain('data-vm-table')
    for (const html of [
      table,
      renderSlots(<VmRack vms={[gemini]} filter='all' size='l' />),
    ]) {
      for (const label of [
        'Gemini account',
        'CRAGAnti',
        '宿主机',
        '已完成官方 Google 授权',
        '尚未拉取模型，不能调度',
        'px-011f7746',
      ]) {
        expect(html).toContain(label)
      }
      expect(html).not.toContain('运行就绪')
    }
    const hostOnly = renderSlots(<VmTable vms={[gemini]} />)
    expect(hostOnly).toContain('role="switch"')
    expect(hostOnly).not.toContain('24h 无请求')
  })

  it('renders a Gemini slot proxy with the same chip as a normal slot', () => {
    const pool = [
      {
        id: 'px-011f7746',
        host: '1.2.3.4',
        port: 1080,
        status: 'ok',
        latency_ms: 88,
      },
    ]
    const gemini = geminiSlot(
      {
        id: 'gemini-proxy',
        name: 'Gemini proxy',
        proxy_id: 'px-011f7746',
        auth_state: 'authorized',
        runtime_ready: false,
        billing_ready: false,
        auth_method: 'oauth',
        kernel_version: null,
        created_at: null,
        updated_at: null,
        models: [],
        account: null,
      },
      undefined,
      pool
    )
    const normal: Vm = {
      id: 'vm-01',
      has_token: true,
      proxy: pool[0],
      proxy_id: 'px-011f7746',
    }
    const chip = (vm: Vm) =>
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <VmRack vms={[vm]} filter='all' size='l' />
        </QueryClientProvider>
      ).match(/<div[^>]*bg-ok-1[^>]*>.*?<\/div>/)?.[0]
    const geminiChip = chip(gemini)
    expect(geminiChip).toContain('1.2.3.4:1080')
    expect(geminiChip).toContain('88')
    expect(geminiChip).toBe(chip(normal))
  })

  it('keeps Gemini rows and cards compact and hides stale eligibility after a newer verified run', () => {
    const verified = geminiSlot({
      id: 'verified-gemini',
      name: 'Verified Gemini',
      proxy_id: 'px-011f7746',
      auth_state: 'authorized',
      auth_method: 'oauth',
      runtime_ready: true,
      billing_ready: true,
      kernel_version: '0.3.0',
      created_at: null,
      updated_at: null,
      models_discovered: true,
      models: ['gemini-2.5-pro'],
      last_inference: {
        state: 'completed',
        model: 'gemini-2.5-pro',
        started_at: '2026-11-24T02:00:00Z',
        finished_at: '2026-11-24T02:00:05Z',
        error_code: null,
      },
      account: {
        state: 'ok',
        checked_at: '2026-11-24T01:00:00Z',
        email: 'a@example.com',
        project_id: null,
        region: null,
        plan: null,
        expires_at: null,
        eligibility: 'verification_required',
        quotas: [],
        credits: [],
      },
    })
    const html = (node: ReactNode) =>
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          {node}
        </QueryClientProvider>
      )
    const table = html(<VmTable vms={[verified]} />)
    expect(table).toContain('data-vm-row')
    expect(table).toMatch(/data-vm-row[^>]*class="[^"]*h-\[38px\]/)
    expect(table).not.toContain('min-h-[38px]')
    for (const view of [
      table,
      html(<VmRack vms={[verified]} size='l' filter='all' />),
      html(<VmRack vms={[verified]} size='s' filter='all' />),
    ]) {
      expect(view).toContain('上次宿主推理成功')
      expect(view).not.toContain('VALIDATION_REQUIRED')
      expect(view).not.toContain('text-[color:var(--status-caution)]')
    }
  })

  it('keeps pending, cancelled, failed and verified turns out of generic 在池 counts', () => {
    const candidate: NonNullable<Vm['gemini']> = {
      id: 'pending-gemini',
      name: 'Pending Gemini',
      proxy_id: 'px-011f7746',
      auth_state: 'authorized',
      auth_method: 'api_key',
      runtime_ready: false,
      billing_ready: false,
      kernel_version: '0.3.0',
      created_at: null,
      updated_at: null,
      models_discovered: true,
      models: ['gemini-2.5-pro'],
      account: null,
    }
    const pending = geminiSlot(candidate)
    const states = ['cancelled', 'failed', 'completed'] as const
    const [cancelled, failed, verified] = states.map((state) =>
      geminiSlot({
        ...candidate,
        id: `${state}-gemini`,
        name: `${state} Gemini`,
        last_inference: {
          state,
          model: candidate.models[0],
          started_at: '2026-11-22T09:00:00Z',
          finished_at: '2026-11-22T09:00:05Z',
          error_code: state === 'failed' ? 'gemini_location_unsupported' : null,
        },
      })
    )
    const vms = [pending, cancelled, failed, verified]
    expect(zoneCounts(vms)).toMatchObject({
      pool: 0,
      pending: 2,
      host_failed: 1,
      host_verified: 1,
      dead: 0,
    })
    expect(filterVms(vms, '', 'pool', 'gemini')).toEqual([])
    expect(filterVms(vms, '', 'pending', 'gemini')).toEqual([
      pending,
      cancelled,
    ])
    expect(filterVms(vms, '', 'host_failed', 'gemini')).toEqual([failed])
    expect(filterVms(vms, '', 'host_verified', 'gemini')).toEqual([verified])

    for (const view of [
      <VmTable vms={vms} />,
      <VmRack vms={vms} size='l' filter='all' />,
      <VmRack vms={vms} size='s' filter='all' />,
    ]) {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          {view}
        </QueryClientProvider>
      )
      expect(html).toContain('已配置 API Key')
      expect(html).toContain('已发现 1 个模型')
      expect(html).toContain('候选条件已满足')
      expect(html).toContain('待验证')
      expect(html).toContain('尚无宿主推理记录')
      expect(html).toContain('上次宿主推理已取消')
      expect(html).toContain('上次宿主推理成功')
      expect(html).toContain('上次宿主推理失败')
      expect(html).toContain('Google 403：地区或账号受限')
      expect(html).toContain('gemini-2.5-pro')
      expect(html).not.toContain('无效凭证')
      expect(html).toContain('role="switch"')
    }

    const pulse = renderToStaticMarkup(
      <FleetPulse vms={vms} filter='pending' onFilter={() => undefined} />
    )
    expect(pulse).toContain('待验证')
    expect(pulse).toContain('宿主推理失败')
    expect(pulse).toContain('宿主推理成功')
    expect(pulse).not.toContain('在池')
  })

  it.each(['wrap', 'cc'] as const)(
    'renders %s as a silver standard kernel',
    (dataplane) => {
      const html = render({ resolved_dataplane: dataplane })
      expect(html).toMatch(/class="[^"]*bg-zinc-200[^"]*"[^>]*>默认<\/span>/)
      expect(html).not.toContain('>crag</span>')
      expect(html).toContain('account@example.com')
    }
  )

  it.each(['legacy', 'v2'] as const)(
    'renders CRAG %s as orange crag',
    (version) => {
      const html = render({
        resolved_dataplane: 'crag',
        resolved_crag_kernel_version: version,
      })
      expect(html).toMatch(/class="[^"]*bg-orange-200[^"]*"[^>]*>crag<\/span>/)
      expect(html).not.toContain('>默认</span>')
    }
  )

  it('uses the resolved route instead of the configured override', () => {
    expect(render({ dataplane: 'wrap', resolved_dataplane: 'crag' })).toContain(
      '>crag</span>'
    )
    expect(render({ dataplane: 'crag', resolved_dataplane: 'wrap' })).toContain(
      '>默认</span>'
    )
  })

  it('supports older responses without a resolved route', () => {
    expect(render({ dataplane: 'crag' })).toContain('>crag</span>')
    expect(render()).toContain('>默认</span>')
  })

  it('shows the platform mark, stable VM number, email and enrollment independently of the auth scheme', () => {
    const vm: Partial<Vm> = {
      has_token: true,
      auth_scheme: 'authorization_bearer',
      subscription_type: 'max',
      runtime_type: 'kvm',
      node_name: '测试集群',
    }
    const html = render(vm)
    expect(html).toContain('aria-label="anthropic"')
    for (const label of [
      'vm-01',
      'accou...@examp',
      'Max',
      'kvm',
      'oauth',
      '测试集群',
    ]) {
      expect(html).toMatch(new RegExp(`>${label}</(?:span|div)>`))
    }
    expect(html).toContain('title="account@example.com"')
    expect(html).not.toContain('订阅 未知')
    expect(html).not.toContain('01·account')
    expect(
      render({
        ...vm,
        credential_mode: 'setup-token',
        oauth_registration: 'oauth',
      })
    ).toContain('>oauth</span>')
    expect(
      render({
        ...vm,
        credential_mode: 'setup-token',
        oauth_registration: 'console',
      })
    ).toContain('>console</span>')
    expect(render({ platform: 'openai', has_token: true })).toContain(
      'aria-label="openai"'
    )
    expect(render({ platform: 'openai', has_token: true })).toContain(
      '>local</span>'
    )
  })
})

describe('VM list summary and toggles', () => {
  it('renders the fleet summary and both list toggles', () => {
    const buckets = Array.from({ length: 48 }, (_, i): [number, number] =>
      i === 47 ? [9, 1] : [0, 0]
    )
    const html = render({ health_24h: buckets, seats_used: 1, seats_max: 4 })
    expect(html).toContain('aria-label="全局汇总"')
    expect(html).toContain('>在池</div>')
    expect(html).toContain('>今日请求数</button>')
    expect(html).toContain('>近 24h 请求</div>')
    expect(html).not.toContain('>24h 请求')
    expect(html).toContain('北京时间今日 0')
    expect(html).toContain('>7 天窗口花费</button>')
    expect(html).toContain('>7 天窗口花费</div>')
    expect(html.match(/7 天窗口花费/g)).toHaveLength(2)
    expect(html).not.toContain('7D 花费')
    expect(html).not.toContain('>今日</div>')
    expect(html).toContain('>90.0%</b>')
    expect(html).toContain('失败 1')
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*按状态分组/)
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*次要信息常显/)
    expect(html).toContain('data-pin="false"')
  })
})

describe('Gemini VM page full UI alignment', () => {
  it('renders Gemini OAuth quota windows, health, seats, cost ledger, pulse, row detail, and sorting', () => {
    const buckets = Array.from({ length: 48 }, (_, i): [number, number] =>
      i === 47 ? [19, 1] : [0, 0]
    )
    const gemini = geminiSlot({
      id: 'gem-pro-1',
      name: 'Gemini Pro 1',
      proxy_id: 'px-gem',
      auth_state: 'authorized',
      auth_method: 'oauth',
      runtime_ready: true,
      billing_ready: true,
      kernel_version: '0.4.9',
      max_concurrency: 10,
      active_slots: 2,
      inflight: 2,
      created_at: null,
      updated_at: null,
      models_discovered: true,
      models: ['gemini-2.5-pro', 'claude-sonnet-4-6-high'],
      last_inference: {
        state: 'completed',
        model: 'gemini-2.5-pro',
        started_at: '2026-11-24T02:00:00Z',
        finished_at: '2026-11-24T02:00:04Z',
        error_code: null,
      },
      usage: {
        today_cost: 3.45,
        today_requests: 20,
        today_tokens: 150000,
        today_input_tokens: 100000,
        today_output_tokens: 30000,
        today_cache_read_tokens: 20000,
        today_cache_creation_tokens: 0,
        cache_hit_rate: 0.1667,
        window_5h_cost: 1.25,
        window_5h_requests: 8,
        window_5h_tokens: 50000,
        window_7d_cost: 12.34,
        window_7d_requests: 40,
        window_7d_success: 38,
        window_7d_errors: 2,
        window_7d_tokens: 450000,
        total_cost: 28.9,
        total_tokens: 900000,
        health_24h: buckets,
      },
      account: {
        state: 'ok',
        checked_at: '2026-11-24T01:00:00Z',
        email: 'gem@example.com',
        project_id: 'proj-1',
        region: 'us',
        plan: 'Google AI Pro',
        expires_at: '2030-01-01T00:00:00Z',
        quotas: [],
        quota_groups: [
          {
            name: 'Gemini',
            windows: [
              {
                id: 'gemini-5h',
                period: '5h',
                remaining_fraction: 0.25,
                reset_at: '2030-01-01T05:00:00Z',
              },
              {
                id: 'gemini-7d',
                period: 'weekly',
                remaining_fraction: 0.6,
                reset_at: '2030-01-07T00:00:00Z',
              },
            ],
          },
          {
            name: 'Claude / 3P',
            windows: [
              {
                id: '3p-5h',
                period: '5h',
                remaining_fraction: 0.5,
                reset_at: '2030-01-01T05:00:00Z',
              },
            ],
          },
        ],
        credits: [],
      },
    })

    // Quota & state mapping
    expect(bladeState(gemini)).toBe('live')
    expect(vmWindows(gemini).map((w) => [w.key, w.pct])).toEqual([
      ['5h', 75],
      ['7d', 40],
    ])
    expect(gemini.seats_used).toBe(2)
    expect(gemini.seats_max).toBe(10)

    const renderNode = (node: ReactNode) =>
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          {node}
        </QueryClientProvider>
      )

    // 1. Table aligns every column + summary bar without "普通槽" split copy
    const table = renderNode(<VmTable vms={[gemini]} />)
    expect(table).toContain('>95.0%</b>')
    expect(table).toContain('>75%</span>')
    expect(table).toContain('>40%</span>')
    expect(table).toContain('不适用')
    expect(table).toContain('2/10')
    expect(table).toContain('$12.34')
    expect(table).toContain('$29')
    expect(table).toContain('bg-orange-200')
    expect(table).not.toContain('普通槽 24h')

    // 2. Grid L and S cards render aligned quota bars, cost ledger, seats, and Gemini stripe
    const rackL = renderNode(<VmRack vms={[gemini]} filter='all' size='l' />)
    expect(rackL).toContain('--tier-gemini-solid')
    expect(rackL).toContain('75%')
    expect(rackL).toContain('40%')
    expect(rackL).toContain('$1.25')
    expect(rackL).toContain('$12.34')
    expect(rackL).toContain('$28.90')
    expect(rackL).toContain('刷新数据')
    expect(rackL).toContain('拉取模型')
    expect(rackL).toContain('执行位')

    const rackS = renderNode(<VmRack vms={[gemini]} filter='all' size='s' />)
    expect(rackS).toContain('--tier-gemini-solid')
    expect(rackS).toContain('$29')

    // 3. FleetPulse includes Gemini headroom, today spend, and 7d success rate
    const pulse = renderNode(
      <FleetPulse vms={[gemini]} filter='all' onFilter={() => undefined} />
    )
    expect(pulse).toContain('60%')
    expect(pulse).toContain('$3.45')
    expect(pulse).toContain('95.0%')
    expect(pulse).toContain('38 成 · 2 败')
    expect(pulse).not.toContain('普通槽')

    // 4. Expanded VmRowDetail renders all 3 cards + multi-group quota breakdown
    const detail = renderNode(
      <VmRowDetail
        id='row-gem-pro-1'
        vm={gemini}
        now={Date.parse('2030-01-01T02:00:00Z')}
        onOpenDetail={() => undefined}
      />
    )
    expect(detail).toContain('请求健康')
    expect(detail).toContain('用量窗口')
    expect(detail).toContain('共享额度分组明细')
    expect(detail).toContain('Claude / 3P')
    expect(detail).toContain('成本')
    expect(detail).toContain('$3.45')

    // 5. SlotIdentity identifies Gemini instead of Claude; name-first with raw email on hover
    const identity = renderNode(<SlotIdentity vm={gemini} compact />)
    expect(identity).toContain('>Gemini</span>')
    expect(identity).toContain('>Gemini Pro 1</span>')
    expect(identity).toContain('title="Gemini Pro 1 · gem@example.com"')
    expect(identity).not.toContain('>Claude</span>')

    // 5b. All slot types (Claude / Codex / Gemini) format detected emails as 5-char prefix + ... + @ + 5-char domain
    const sampleEmail = '12345678@gmail21321.com'
    const allSlots: Vm[] = [
      {
        id: 'vm-c1',
        name: 'Claude 1',
        platform: 'anthropic',
        email: sampleEmail,
        has_token: true,
      },
      {
        id: 'vm-o1',
        name: 'Codex 1',
        platform: 'openai',
        family: 'codex',
        email: sampleEmail,
        has_token: true,
      },
      { ...gemini, id: 'gem-e1', email: sampleEmail },
    ]
    for (const slot of allSlots) {
      expect(renderNode(<VmTable vms={[slot]} />)).toContain(
        '>12345...@gmail</span>'
      )
      expect(
        renderNode(<VmRack vms={[slot]} filter='all' size='l' />)
      ).toContain('>12345...@gmail</div>')
      expect(
        renderNode(<VmRack vms={[slot]} filter='all' size='s' />)
      ).toContain('>12345...@gmail</div>')
      // SlotIdentity 名称优先（识别靠名称体系），完整邮箱放悬停 title
      expect(renderNode(<SlotIdentity vm={slot} compact />)).toContain(
        `title="${slot.name} · ${sampleEmail}"`
      )
    }

    // 6. Probed Gemini participates in remain sort alongside normal slots
    const claudeLow: Vm = {
      id: 'vm-low',
      has_token: true,
      utilization_5h: 0.9,
    }
    const sorted = sortVms([claudeLow, gemini], 'remain', 'desc')
    expect(sorted.map((v) => v.id)).toEqual(['gem-pro-1', 'vm-low'])
  })

  it('renders Gemini API Key without fake quota bars while preserving cost ledger', () => {
    const apiKeySlot = geminiSlot({
      id: 'gem-key-1',
      name: 'Gemini Key',
      proxy_id: 'px-gem',
      auth_state: 'authorized',
      auth_method: 'api_key',
      runtime_ready: true,
      billing_ready: true,
      kernel_version: '0.4.9',
      created_at: null,
      updated_at: null,
      models_discovered: true,
      models: ['gemini-2.5-pro'],
      usage: {
        today_cost: 0.5,
        today_requests: 3,
        today_tokens: 12000,
        today_input_tokens: 8000,
        today_output_tokens: 4000,
        today_cache_read_tokens: 0,
        today_cache_creation_tokens: 0,
        cache_hit_rate: null,
        window_5h_cost: 0.5,
        window_5h_requests: 3,
        window_5h_tokens: 12000,
        window_7d_cost: 2.1,
        window_7d_requests: 15,
        window_7d_success: 15,
        window_7d_errors: 0,
        window_7d_tokens: 55000,
        total_cost: 2.1,
        total_tokens: 55000,
        health_24h: null,
      },
      account: null,
    })

    expect(bladeState(apiKeySlot)).toBe('live')
    expect(vmWindows(apiKeySlot)).toEqual([])
    const rack = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <VmRack vms={[apiKeySlot]} filter='all' size='l' />
      </QueryClientProvider>
    )
    expect(rack).toContain('API Key 按量计费')
    expect(rack).toContain('$2.10')
  })

  it('renders Gemini scheduling switch, priority badge, restriction, paused, and owner states', () => {
    const base: NonNullable<Vm['gemini']> = {
      id: 'gem-ctl-1',
      name: 'Gemini Ctrl',
      proxy_id: 'px-gem',
      auth_state: 'authorized',
      auth_method: 'oauth',
      runtime_ready: true,
      billing_ready: true,
      kernel_version: '0.4.9',
      created_at: null,
      updated_at: null,
      models_discovered: true,
      models: ['gemini-2.5-pro'],
      account: {
        state: 'ok',
        checked_at: '2030-01-01T00:00:00Z',
        email: 'ctrl@example.com',
        project_id: null,
        region: null,
        plan: 'Google AI Pro',
        expires_at: null,
        quotas: [],
        credits: [],
      },
    }

    const manualHigh = geminiSlot({
      ...base,
      schedule_level: 8,
      schedule_level_mode: 'manual',
      owner_user_id: 'u-tenant-1',
    })
    expect(canReclaimVm(manualHigh)).toBe(true)
    const tableManual = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <VmTable vms={[manualHigh]} />
      </QueryClientProvider>
    )
    expect(tableManual).toContain('role="switch"')
    expect(tableManual).toContain('P8')
    expect(tableManual).toContain('>手</small>')

    const paused = geminiSlot({
      ...base,
      id: 'gem-off',
      schedulable: false,
    })
    expect(zoneCounts([paused]).off).toBe(1)
    const tableOff = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <VmTable vms={[paused]} />
      </QueryClientProvider>
    )
    expect(tableOff).toContain('手动关闭')

    const cooled = geminiSlot({
      ...base,
      id: 'gem-cool',
      restriction: {
        reason: 'account_cooldown',
        text: '账号冷却中',
        until: Date.now() + 120_000,
      },
    })
    expect(zoneCounts([cooled]).restricted).toBe(1)
    expect(restrictionTitle(cooled)).toContain('账号冷却中')

    const tripped = geminiSlot({
      ...base,
      id: 'gem-trip',
      restriction: {
        reason: 'circuit_open',
        text: '熔断中',
        until: Date.now() + 60_000,
      },
      circuit: {
        state: 'open',
        failures: 3,
        threshold: 3,
        open_until: Date.now() + 60_000,
        open_ms: 60_000,
      },
    })
    expect(zoneCounts([tripped]).restricted).toBe(1)
    expect(restrictionTitle(tripped)).toContain('熔断中')
  })
})
